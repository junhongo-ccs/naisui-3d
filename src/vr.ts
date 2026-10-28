import * as THREE from 'three';
import type { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { depthColor, parseDepthLabel } from './flood';

type PointAt = ( ray: THREE.Raycaster ) => { distance: number, flood: { point: THREE.Vector3, label: string } | null };

// Quest controller locomotion. The headset pose is applied to `camera` relative to `rig`,
// so moving and turning are done by moving `rig`.
//   left stick:   move along the gaze direction (horizontal)
//   right stick:  X = 45° snap turn, Y = rise / sink
//   trigger held: 10× speed
//   right hand:   point at a flood polygon to float its depth over it (no button needed,
//                 since the trigger is taken; works with hand tracking too)
//   A button:     raise / lower the water surface
export function initVR( { renderer, scene, camera, rig, controls, groundTargets, pointAt, toggleWater }: {
	renderer: THREE.WebGLRenderer,
	scene: THREE.Scene,
	camera: THREE.PerspectiveCamera,
	rig: THREE.Group,
	controls: OrbitControls,
	groundTargets: () => THREE.Object3D[],
	pointAt: PointAt,
	toggleWater: () => void,
} ) {

	const WALK = 6; // m/s
	const saved = { position: new THREE.Vector3(), quaternion: new THREE.Quaternion() };
	const raycaster = new THREE.Raycaster();
	raycaster.firstHitOnly = true;
	const forward = new THREE.Vector3();
	const right = new THREE.Vector3();
	const head = new THREE.Vector3();
	let turnLatched = false;
	let aWasPressed = false;
	const pointer = createPointer( renderer, scene, rig, pointAt );

	// Height of the ground (terrain or roof) under a point, in local meters.
	function groundAt( x: number, z: number ): number {

		raycaster.set( new THREE.Vector3( x, 5000, z ), new THREE.Vector3( 0, - 1, 0 ) );
		const hit = raycaster.intersectObjects( groundTargets(), true )[ 0 ];
		return hit ? hit.point.y : 0;

	}

	renderer.xr.addEventListener( 'sessionstart', () => {

		saved.position.copy( camera.position );
		saved.quaternion.copy( camera.quaternion );
		// Stand on the street at the point the orbit view was looking at.
		const { x, z } = controls.target;
		rig.position.set( x, groundAt( x, z ), z );
		rig.rotation.set( 0, 0, 0 );

	} );

	renderer.xr.addEventListener( 'sessionend', () => {

		pointer.hide();
		rig.position.set( 0, 0, 0 );
		rig.rotation.set( 0, 0, 0 );
		camera.position.copy( saved.position );
		camera.quaternion.copy( saved.quaternion );
		controls.update();

	} );

	function update( dt: number ) {

		const session = renderer.xr.getSession();
		if ( ! session ) return;

		let move = [ 0, 0 ], turn = 0, lift = 0, boost = false;
		for ( const src of session.inputSources ) {

			const gp = src.gamepad;
			if ( ! gp ) continue;
			const ax = gp.axes.length >= 4 ? [ gp.axes[ 2 ], gp.axes[ 3 ] ] : [ gp.axes[ 0 ] ?? 0, gp.axes[ 1 ] ?? 0 ];
			const dz = ( v: number ) => ( Math.abs( v ) < 0.15 ? 0 : v );
			if ( src.handedness === 'left' ) move = [ dz( ax[ 0 ] ), dz( ax[ 1 ] ) ];
			if ( src.handedness === 'right' ) {

				turn = ax[ 0 ];
				lift = - dz( ax[ 1 ] );
				// xr-standard mapping: buttons[4] is A on the right Touch controller.
				const a = !! gp.buttons[ 4 ]?.pressed;
				if ( a && ! aWasPressed ) toggleWater();
				aWasPressed = a;

			}

			if ( gp.buttons[ 0 ]?.pressed ) boost = true;

		}

		const speed = WALK * ( boost ? 10 : 1 ) * dt;
		const xrCam = renderer.xr.getCamera();
		xrCam.getWorldDirection( forward );
		forward.y = 0;
		forward.normalize();
		right.crossVectors( forward, rig.up ).normalize();
		rig.position.addScaledVector( forward, - move[ 1 ] * speed );
		rig.position.addScaledVector( right, move[ 0 ] * speed );
		rig.position.y += lift * speed;

		if ( Math.abs( turn ) > 0.7 && ! turnLatched ) {

			// Turn around the head, not the rig origin, so the view doesn't slide.
			xrCam.getWorldPosition( head );
			const angle = - Math.sign( turn ) * Math.PI / 4;
			rig.position.sub( head ).applyAxisAngle( rig.up, angle ).add( head );
			rig.rotateY( angle );
			turnLatched = true;

		} else if ( Math.abs( turn ) < 0.3 ) {

			turnLatched = false;

		}

		// Point with where the hand is after this frame's move, not last frame's.
		rig.updateMatrixWorld( true );
		pointer.update( dt, xrCam );

	}

	return { update };

}

// A ray from the right controller (or right hand) and a depth label at the flood polygon it hits.
function createPointer( renderer: THREE.WebGLRenderer, scene: THREE.Scene, rig: THREE.Group, pointAt: PointAt ) {

	const RAY_MAX = 300; // m, drawn length when the ray hits nothing
	const PICK_INTERVAL = 0.05; // s; raycasting the tiles every frame is too heavy for the headset

	const controllers = [ 0, 1 ].map( i => {

		const c = renderer.xr.getController( i );
		const line = new THREE.Line(
			new THREE.BufferGeometry().setFromPoints( [ new THREE.Vector3( 0, 0, 0 ), new THREE.Vector3( 0, 0, - 1 ) ] ),
			new THREE.LineBasicMaterial( { color: '#ffffff', transparent: true, opacity: 0.6 } ),
		);
		line.visible = false;
		c.add( line );
		c.addEventListener( 'connected', e => ( c.userData.handedness = ( e.data as XRInputSource ).handedness ) );
		c.addEventListener( 'disconnected', () => ( c.userData.handedness = undefined ) );
		rig.add( c );
		return { c, line };

	} );

	// Drawn over everything so the label isn't buried in a building or the ground.
	const label = new THREE.Sprite( new THREE.SpriteMaterial( { depthTest: false, transparent: true } ) );
	label.center.set( 0.5, - 0.4 );
	label.renderOrder = 1000;
	const dot = new THREE.Mesh(
		new THREE.SphereGeometry( 1, 12, 8 ),
		new THREE.MeshBasicMaterial( { color: '#ffffff', depthTest: false } ),
	);
	dot.renderOrder = 1000;
	label.visible = dot.visible = false;
	scene.add( label, dot );

	const ray = new THREE.Raycaster();
	ray.far = 5000;
	ray.firstHitOnly = true;
	const head = new THREE.Vector3();
	let sinceLastPick = Infinity;
	let shown = '';
	let hit: ReturnType<PointAt> | null = null;

	function setText( depthLabel: string ) {

		if ( depthLabel === shown ) return;
		shown = depthLabel;
		const text = `想定浸水深 ${ depthLabel }`;
		const canvas = document.createElement( 'canvas' );
		const ctx = canvas.getContext( '2d' )!;
		const font = 'bold 56px system-ui, sans-serif';
		ctx.font = font;
		const pad = 28, swatch = 44, h = 96;
		canvas.width = Math.ceil( pad + swatch + 20 + ctx.measureText( text ).width + pad );
		canvas.height = h;
		ctx.fillStyle = 'rgba(20, 26, 36, 0.88)';
		ctx.beginPath();
		ctx.roundRect( 0, 0, canvas.width, h, 24 );
		ctx.fill();
		ctx.fillStyle = `#${ depthColor( parseDepthLabel( depthLabel ) ).getHexString() }`;
		ctx.fillRect( pad, ( h - swatch ) / 2, swatch, swatch );
		ctx.font = font;
		ctx.fillStyle = '#ffffff';
		ctx.textBaseline = 'middle';
		ctx.fillText( text, pad + swatch + 20, h / 2 + 2 );

		const mat = label.material;
		mat.map?.dispose();
		mat.map = new THREE.CanvasTexture( canvas );
		mat.map.colorSpace = THREE.SRGBColorSpace;
		mat.needsUpdate = true;
		label.userData.aspect = canvas.width / canvas.height;

	}

	function hide() {

		label.visible = dot.visible = false;
		controllers.forEach( ( { line } ) => ( line.visible = false ) );
		hit = null;

	}

	function update( dt: number, xrCam: THREE.Camera ) {

		const active = controllers.find( ( { c } ) => c.userData.handedness === 'right' );
		controllers.forEach( ( { line } ) => ( line.visible = false ) );
		if ( ! active ) {

			hide();
			return;

		}

		sinceLastPick += dt;
		if ( sinceLastPick >= PICK_INTERVAL ) {

			sinceLastPick = 0;
			ray.setFromXRController( active.c );
			hit = pointAt( ray );

		}

		active.line.visible = true;
		active.line.scale.z = Math.min( hit?.distance ?? RAY_MAX, RAY_MAX );

		const flood = hit?.flood;
		label.visible = dot.visible = !! flood;
		if ( ! flood ) return;

		// Keep the label the same apparent size however far away it is.
		setText( flood.label );
		const dist = xrCam.getWorldPosition( head ).distanceTo( flood.point );
		const h = dist * 0.05;
		label.position.copy( flood.point );
		label.scale.set( h * label.userData.aspect, h, 1 );
		dot.position.copy( flood.point );
		dot.scale.setScalar( dist * 0.005 );

	}

	return { update, hide };

}
