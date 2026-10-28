import * as THREE from 'three';
import type { OrbitControls } from 'three/addons/controls/OrbitControls.js';

// Quest controller locomotion. The headset pose is applied to `camera` relative to `rig`,
// so moving and turning are done by moving `rig`.
//   left stick:   move along the gaze direction (horizontal)
//   right stick:  X = 45° snap turn, Y = rise / sink
//   trigger held: 10× speed
export function initVR( { renderer, camera, rig, controls, groundTargets }: {
	renderer: THREE.WebGLRenderer,
	camera: THREE.PerspectiveCamera,
	rig: THREE.Group,
	controls: OrbitControls,
	groundTargets: () => THREE.Object3D[],
} ) {

	const WALK = 6; // m/s
	const saved = { position: new THREE.Vector3(), quaternion: new THREE.Quaternion() };
	const raycaster = new THREE.Raycaster();
	const forward = new THREE.Vector3();
	const right = new THREE.Vector3();
	const head = new THREE.Vector3();
	let turnLatched = false;

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

	}

	return { update };

}
