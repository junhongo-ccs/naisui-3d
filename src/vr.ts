import * as THREE from 'three';
import type { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { depthColor, parseDepthLabel } from './flood';
import { createCityMenu, type CityItem } from './vr-menu';
import { createDebugBoard } from './vr-debug';

type PointAt = ( ray: THREE.Raycaster ) => { distance: number, flood: { point: THREE.Vector3, label: string } | null };

// Quest controller locomotion. The headset pose is applied to `camera` relative to `rig`,
// so moving and turning are done by moving `rig`.
//   left stick:   move along the gaze direction (horizontal)
//   right stick:  X = 45° snap turn, Y = rise / sink
//   trigger held: 5× speed
//   right hand:   point at a flood polygon to float its depth over it (no button needed,
//                 since the trigger is taken; works with hand tracking too)
//   A button:     raise / lower the water surface
//   B button:     leave VR (back to the map view)
//   Y button:     back to where VR started
//   right grip:   open / close the city list; point at a city and pull the trigger to go there
//   X button:     diagnostics board (errors, inputs, pointer state) in place of the controls card;
//                 it also opens by itself when an error happens
// Speed scales with height above the ground, so crossing the city from the air isn't a crawl
// and the street stays walkable. A card on the left controller lists these.
export function initVR( { renderer, scene, camera, rig, controls, groundTargets, pointAt, toggleWater, cities, currentCity, selectCity }: {
	renderer: THREE.WebGLRenderer,
	scene: THREE.Scene,
	camera: THREE.PerspectiveCamera,
	rig: THREE.Group,
	controls: OrbitControls,
	groundTargets: () => THREE.Object3D[],
	pointAt: PointAt,
	toggleWater: () => void,
	cities: CityItem[],
	currentCity: () => string,
	selectCity: ( code: string ) => void,
} ) {

	const MIN_SPEED = 15; // m/s at street level; above that, speed (m/s) = height above ground (m)
	const BOOST = 5;
	const GROUND_INTERVAL = 0.2; // s between ground-height raycasts (too heavy for every frame)
	const saved = { position: new THREE.Vector3(), quaternion: new THREE.Quaternion() };
	const raycaster = new THREE.Raycaster();
	raycaster.firstHitOnly = true;
	const forward = new THREE.Vector3();
	const right = new THREE.Vector3();
	const head = new THREE.Vector3();
	const start = new THREE.Vector3();
	let turnLatched = false;
	const wasPressed: Record<string, boolean> = {};
	let groundY = 0;
	let sinceGround = Infinity;
	const menu = createCityMenu( cities );
	const pointer = createPointer( renderer, scene, rig, pointAt, menu );
	const debug = createDebugBoard();
	let showDebug = false;
	debug.onError = () => ( showDebug = true );
	const help = createHelpCard( renderer, rig, debug.mesh );
	let fps = 0;
	let sinceStatus = Infinity;
	let lastHeight = 0;

	// True on the frame a button goes down.
	function pressed( key: string, gp: Gamepad, index: number ): boolean {

		const now = !! gp.buttons[ index ]?.pressed;
		const edge = now && ! wasPressed[ key ];
		wasPressed[ key ] = now;
		return edge;

	}

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
		start.copy( rig.position );
		sinceGround = Infinity;

	} );

	renderer.xr.addEventListener( 'sessionend', () => {

		pointer.hide();
		menu.close();
		rig.position.set( 0, 0, 0 );
		rig.rotation.set( 0, 0, 0 );
		camera.position.copy( saved.position );
		camera.quaternion.copy( saved.quaternion );
		controls.update();

	} );

	function update( dt: number ) {

		if ( ! renderer.xr.getSession() ) return;
		// Report a failing frame on the board instead of losing it to a console nobody can see.
		try {

			step( dt );

		} catch ( e ) {

			const err = e as Error;
			debug.error( `VR の更新: ${ err?.message ?? err } ${ err?.stack?.split( '\n' )[ 1 ]?.trim() ?? '' }` );

		}

		fps = fps ? fps * 0.9 + 0.1 / Math.max( dt, 1e-3 ) : 1 / Math.max( dt, 1e-3 );
		sinceStatus += dt;
		if ( showDebug && sinceStatus >= 0.25 ) {

			sinceStatus = 0;
			debug.setStatus( statusLines() );

		}

		help.update( showDebug );
		debug.update();

	}

	function statusLines(): string[] {

		const f = ( v: number ) => v.toFixed( 1 );
		const p = rig.position;
		const info = renderer.info.render;
		const lines = [
			`${ Math.round( fps ) } fps　描画 ${ info.calls } 回　${ Math.round( info.triangles / 1000 ) }k 三角形`,
			`${ cities.find( c => c.code === currentCity() )?.city ?? currentCity() }　位置 ${ f( p.x ) }, ${ f( p.y ) }, ${ f( p.z ) }　地面から ${ f( lastHeight ) } m　一覧 ${ menu.isOpen ? '開' : '閉' }`,
		];
		for ( const src of renderer.xr.getSession()?.inputSources ?? [] ) {

			const gp = src.gamepad;
			const down = gp ? gp.buttons.flatMap( ( b, i ) => ( b.pressed ? [ i ] : [] ) ) : [];
			const state = gp ? `押下[${ down }] 軸[${ gp.axes.map( a => a.toFixed( 1 ) ) }]` : 'gamepad なし';
			lines.push( `入力 ${ src.handedness } ${ src.hand ? '手' : 'コントローラー' } ${ state }` );

		}

		return lines.concat( pointer.status() );

	}

	function step( dt: number ) {

		const session = renderer.xr.getSession()!;

		let move = [ 0, 0 ], turn = 0, lift = 0, boost = false, toggleMenu = false, choose = false;
		for ( const src of session.inputSources ) {

			const gp = src.gamepad;
			if ( ! gp ) continue;
			const ax = gp.axes.length >= 4 ? [ gp.axes[ 2 ], gp.axes[ 3 ] ] : [ gp.axes[ 0 ] ?? 0, gp.axes[ 1 ] ?? 0 ];
			const dz = ( v: number ) => ( Math.abs( v ) < 0.15 ? 0 : v );
			if ( src.handedness === 'left' ) move = [ dz( ax[ 0 ] ), dz( ax[ 1 ] ) ];
			if ( src.handedness === 'right' ) {

				turn = ax[ 0 ];
				lift = - dz( ax[ 1 ] );
				// xr-standard mapping: buttons[4] / [5] are A / B (right) and X / Y (left).
				if ( pressed( 'A', gp, 4 ) ) toggleWater();
				if ( pressed( 'grip', gp, 1 ) ) toggleMenu = true;
				// With the list open, the right trigger picks a city instead of speeding up.
				if ( pressed( 'trigger', gp, 0 ) && menu.isOpen ) choose = true;
				if ( pressed( 'B', gp, 5 ) ) {

					session.end();
					return;

				}

			}

			if ( src.handedness === 'left' && pressed( 'X', gp, 4 ) ) showDebug = ! showDebug;
			if ( src.handedness === 'left' && pressed( 'Y', gp, 5 ) ) {

				rig.position.copy( start );
				rig.rotation.set( 0, 0, 0 );
				sinceGround = Infinity;

			}

			if ( gp.buttons[ 0 ]?.pressed && ! ( menu.isOpen && src.handedness === 'right' ) ) boost = true;

		}

		// The head pose in the world. Not renderer.xr.getCamera(): that camera has no parent, so its
		// "world" position and direction are relative to the rig. three.js copies the headset pose
		// onto `camera` (a child of the rig) every frame, so this one is right.
		const headCam = camera;
		if ( choose && menu.hoveredCode ) {

			const code = menu.hoveredCode;
			menu.close();
			selectCity( code );

		} else if ( toggleMenu ) {

			if ( menu.isOpen ) menu.close();
			else menu.open( headCam, rig, currentCity() );

		}

		sinceGround += dt;
		if ( sinceGround >= GROUND_INTERVAL ) {

			sinceGround = 0;
			groundY = groundAt( rig.position.x, rig.position.z );

		}

		const height = Math.max( rig.position.y - groundY, 0 );
		lastHeight = height;
		const speed = Math.max( MIN_SPEED, height ) * ( boost ? BOOST : 1 ) * dt;
		headCam.getWorldDirection( forward );
		forward.y = 0;
		forward.normalize();
		right.crossVectors( forward, rig.up ).normalize();
		rig.position.addScaledVector( forward, - move[ 1 ] * speed );
		rig.position.addScaledVector( right, move[ 0 ] * speed );
		rig.position.y += lift * speed;

		if ( Math.abs( turn ) > 0.7 && ! turnLatched ) {

			// Turn around the head, not the rig origin, so the view doesn't slide.
			headCam.getWorldPosition( head );
			const angle = - Math.sign( turn ) * Math.PI / 4;
			rig.position.sub( head ).applyAxisAngle( rig.up, angle ).add( head );
			rig.rotateY( angle );
			turnLatched = true;

		} else if ( Math.abs( turn ) < 0.3 ) {

			turnLatched = false;

		}

		// Point with where the hand is after this frame's move, not last frame's.
		rig.updateMatrixWorld( true );
		pointer.update( dt, headCam );

	}

	// Place the user somewhere new (after switching cities); Y returns here.
	function arrive( position: THREE.Vector3 ) {

		rig.position.copy( position );
		rig.rotation.set( 0, 0, 0 );
		start.copy( position );
		sinceGround = Infinity;

	}

	return { update, arrive };

}

// A ray from the right controller (or right hand) and a depth label at the flood polygon it hits.
// With the city list open, the ray points at the list instead.
function createPointer( renderer: THREE.WebGLRenderer, scene: THREE.Scene, rig: THREE.Group, pointAt: PointAt, menu: ReturnType<typeof createCityMenu> ) {

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

	function update( dt: number, headCam: THREE.Camera ) {

		const active = controllers.find( ( { c } ) => c.userData.handedness === 'right' );
		controllers.forEach( ( { line } ) => ( line.visible = false ) );
		if ( ! active ) {

			hide();
			return;

		}

		active.line.visible = true;
		if ( menu.isOpen ) {

			label.visible = dot.visible = false;
			ray.setFromXRController( active.c );
			active.line.scale.z = Math.min( menu.hover( ray ) ?? RAY_MAX, RAY_MAX );
			hit = null;
			sinceLastPick = Infinity;
			return;

		}

		sinceLastPick += dt;
		if ( sinceLastPick >= PICK_INTERVAL ) {

			sinceLastPick = 0;
			ray.setFromXRController( active.c );
			hit = pointAt( ray );

		}

		active.line.scale.z = Math.min( hit?.distance ?? RAY_MAX, RAY_MAX );

		const flood = hit?.flood;
		label.visible = dot.visible = !! flood;
		if ( ! flood ) return;

		// Keep the label the same apparent size however far away it is.
		setText( flood.label );
		const dist = headCam.getWorldPosition( head ).distanceTo( flood.point );
		const h = dist * 0.05;
		label.position.copy( flood.point );
		label.scale.set( h * label.userData.aspect, h, 1 );
		dot.position.copy( flood.point );
		dot.scale.setScalar( dist * 0.005 );

	}

	// One line per controller, then what the ray is on, for the diagnostics board.
	function status(): string[] {

		const lines = controllers.map( ( { c, line }, i ) => {

			const ray = line.visible ? `○ ${ line.scale.z.toFixed( 1 ) } m` : '×';
			return `手${ i } ${ c.userData.handedness ?? '未接続' }　姿勢${ c.visible ? '○' : '×' }　光線${ ray }${ c.parent ? '' : '（シーン外）' }`;

		} );
		const target = ! hit ? '-' : hit.flood ? hit.flood.label : hit.distance === Infinity ? 'なし' : `${ hit.distance.toFixed( 0 ) } m 先の建物`;
		return lines.concat( `指す先: ${ target }` );

	}

	return { update, hide, status };

}

// A card above the left controller listing the controls. The diagnostics board takes its place
// when shown.
function createHelpCard( renderer: THREE.WebGLRenderer, rig: THREE.Group, debugBoard: THREE.Object3D ) {

	const lines = [
		[ '左スティック', '移動' ],
		[ '右スティック', '左右: 向きを変える　上下: 上昇・下降' ],
		[ 'トリガー', '押している間 5 倍速' ],
		[ '右手で指す', '想定浸水深を表示' ],
		[ 'A', '水面を上げる・下げる' ],
		[ 'グリップ（右）', '市町村を選ぶ' ],
		[ 'X', '診断を表示' ],
		[ 'Y', 'スタート地点に戻る' ],
		[ 'B', 'VR を終了' ],
	];
	const canvas = document.createElement( 'canvas' );
	const ctx = canvas.getContext( '2d' )!;
	const pad = 36, row = 64, keyWidth = 300;
	canvas.width = 1100;
	canvas.height = pad * 2 + row * lines.length;
	ctx.fillStyle = 'rgba(20, 26, 36, 0.88)';
	ctx.beginPath();
	ctx.roundRect( 0, 0, canvas.width, canvas.height, 32 );
	ctx.fill();
	ctx.textBaseline = 'middle';
	lines.forEach( ( [ key, action ], i ) => {

		const y = pad + row * ( i + 0.5 );
		ctx.font = 'bold 40px system-ui, sans-serif';
		ctx.fillStyle = '#9fd3ff';
		ctx.fillText( key, pad, y );
		ctx.font = '40px system-ui, sans-serif';
		ctx.fillStyle = '#ffffff';
		ctx.fillText( action, pad + keyWidth, y );

	} );

	const texture = new THREE.CanvasTexture( canvas );
	texture.colorSpace = THREE.SRGBColorSpace;
	const width = 0.2; // m
	const card = new THREE.Mesh(
		new THREE.PlaneGeometry( width, width * canvas.height / canvas.width ),
		new THREE.MeshBasicMaterial( { map: texture, transparent: true, depthTest: false } ),
	);
	card.renderOrder = 1000;
	// Above the controller, tilted back toward the face.
	card.position.set( 0, 0.12, - 0.04 );
	card.rotation.x = - Math.PI / 6;
	card.visible = false;
	debugBoard.position.set( 0, 0.17, - 0.07 );
	debugBoard.rotation.x = - Math.PI / 6;
	debugBoard.visible = false;

	const controllers = [ 0, 1 ].map( i => {

		const c = renderer.xr.getController( i );
		rig.add( c );
		return c;

	} );

	function update( showDebug: boolean ) {

		const left = controllers.find( c => c.userData.handedness === 'left' );
		for ( const [ panel, on ] of [ [ card, ! showDebug ], [ debugBoard, showDebug ] ] as const ) {

			if ( left && panel.parent !== left ) left.add( panel );
			panel.visible = !! left && on;

		}

	}

	return { update };

}
