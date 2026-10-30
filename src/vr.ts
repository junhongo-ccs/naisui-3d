import * as THREE from 'three';
import type { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { billboard, pose, setTexture } from './billboard';
import { depthColor, parseDepthLabel } from './flood';
import { createCityMenu, type CityItem } from './vr-menu';
import { createDebugBoard } from './vr-debug';
import type { createMinimap } from './vr-minimap';
import type { createPins, Place } from './places';

type PointAt = ( ray: THREE.Raycaster ) => { distance: number, flood: { point: THREE.Vector3, label: string } | null };
type Pins = ReturnType<typeof createPins>;
type Minimap = ReturnType<typeof createMinimap>;

// Quest controller locomotion. The headset pose is applied to `camera` relative to `rig`,
// so moving and turning are done by moving `rig`.
//   left stick:   move along the gaze direction (horizontal)
//   right stick:  X = 45° snap turn, Y = rise / sink
//   trigger held: 5× speed
//   right hand:   point at a flood polygon to float its depth over it (no button needed,
//                 since the trigger is taken; works with hand tracking too)
//   right trigger on a pin: open / close its card (instead of speeding up)
//   A button:     raise / lower the water surface
//   B button:     leave VR (back to the map view)
//   Y button:     back to where VR started
//   right grip:   open / close the city list; point at a city and pull the trigger to go there
//                 (only when there is more than one city)
//   X button:     diagnostics board (errors, inputs, pointer state) in place of the controls card;
//                 it also opens by itself when an error happens
// Speed scales with height above the ground, so crossing the city from the air isn't a crawl
// and the street stays walkable. Movement stops at the edge of `bounds`, so the user can't drift
// off the city and lose it. The left controller carries a map of the city with an arrow for the
// user, and a card listing these controls.
export function initVR( { renderer, scene, camera, rig, controls, groundTargets, pointAt, toggleWater, cities, currentCity, selectCity, pins, minimap, bounds, toLatLon, startPose, tileStatus }: {
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
	pins: Pins,
	minimap: Minimap,
	bounds: () => THREE.Box3, // where the rig may go, in scene meters
	toLatLon: ( p: THREE.Vector3 ) => { lat: number, lon: number },
	// Where to stand (feet, in scene meters) and which way to face (radians about y, 0 = north)
	// when VR starts, or null to stand where the map view was looking.
	startPose: () => { position: THREE.Vector3, yaw: number } | null,
	tileStatus: () => string[], // lines for the diagnostics board
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
	let startYaw = 0;
	let turnLatched = false;
	const wasPressed: Record<string, boolean> = {};
	let groundY = 0;
	let sinceGround = Infinity;
	const hasMenu = cities.length > 1;
	const menu = createCityMenu( cities );
	const pointer = createPointer( renderer, scene, rig, pointAt, menu, pins );
	const debug = createDebugBoard();
	let showDebug = false;
	debug.onError = () => ( showDebug = true );
	const help = createHandPanel( renderer, rig, minimap, debug.mesh, hasMenu );
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
		// Stand at the city's start point, or on the street at the point the orbit view was looking
		// at. The start point's height comes from its known elevation, not a raycast: right after
		// entering, only coarse tiles are loaded near it, and their surface can be meters off.
		const pose = startPose();
		if ( pose ) {

			arrive( pose.position, pose.yaw );

		} else {

			const { x, z } = controls.target;
			arrive( new THREE.Vector3( x, groundAt( x, z ), z ) );

		}

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
			...tileStatus(),
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
				if ( pressed( 'grip', gp, 1 ) && hasMenu ) toggleMenu = true;
				// With the list open, the right trigger picks a city instead of speeding up; on a
				// pin, it opens or closes the pin's card; on the card's × button, it closes the card;
				// on the card's top strip, it grabs the card until let go.
				if ( pressed( 'trigger', gp, 0 ) ) {

					if ( menu.isOpen ) choose = true;
					else if ( pointer.onCard?.part === 'close' ) pins.close();
					else if ( pointer.onCard?.part === 'grab' ) pointer.grab();
					else if ( pointer.hoveredPlace ) pins.toggle( pointer.hoveredPlace );

				}
				if ( pins.dragging && ! gp.buttons[ 0 ]?.pressed ) pointer.release();
				if ( pressed( 'B', gp, 5 ) ) {

					session.end();
					return;

				}

			}

			if ( src.handedness === 'left' && pressed( 'X', gp, 4 ) ) showDebug = ! showDebug;
			if ( src.handedness === 'left' && pressed( 'Y', gp, 5 ) ) {

				arrive( start.clone(), startYaw );

			}

			const rightTriggerTaken = menu.isOpen || pointer.hoveredPlace || pointer.onCard || pins.dragging;
			if ( gp.buttons[ 0 ]?.pressed && ! ( rightTriggerTaken && src.handedness === 'right' ) ) boost = true;

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
		bounds().clampPoint( rig.position, rig.position );

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

		// Clockwise from north; the scene's north is -z.
		headCam.getWorldPosition( head );
		const { lat, lon } = toLatLon( head );
		minimap.setPosition( lat, lon, Math.atan2( forward.x, - forward.z ) );

	}

	// Place the user somewhere new (on entering VR, after switching cities); Y returns here.
	function arrive( position: THREE.Vector3, yaw = 0 ) {

		rig.position.copy( position );
		rig.rotation.set( 0, yaw, 0 );
		start.copy( position );
		startYaw = yaw;
		sinceGround = Infinity;

	}

	return { update, arrive };

}

// A ray from the right controller (or right hand) and a depth label at the flood polygon it hits.
// With the city list open, the ray points at the list instead.
function createPointer( renderer: THREE.WebGLRenderer, scene: THREE.Scene, rig: THREE.Group, pointAt: PointAt, menu: ReturnType<typeof createCityMenu>, pins: Pins ) {

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

	// Drawn over everything so the label isn't buried in a building or the ground. Upright, facing
	// the eye, like the pins' labels.
	const label = billboard( null, 0.5, - 0.4, 1000 );
	const dot = new THREE.Mesh(
		new THREE.SphereGeometry( 1, 12, 8 ),
		new THREE.MeshBasicMaterial( { color: '#ffffff', depthTest: false } ),
	);
	dot.renderOrder = 1000;
	label.obj.visible = dot.visible = false;
	scene.add( label.obj, dot );

	const ray = new THREE.Raycaster();
	ray.far = 5000;
	ray.firstHitOnly = true;
	const head = new THREE.Vector3();
	let sinceLastPick = Infinity;
	let shown = '';
	let hit: ReturnType<PointAt> | null = null;
	// A pin under the ray, when it is nearer than whatever else the ray hits.
	let place: { place: Place, distance: number } | null = null;
	// The open card under the ray (it is drawn over everything, so it comes first).
	let onCard: ReturnType<Pins[ 'pickCard' ]> = null;

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

		setTexture( label, canvas );

	}

	function hide() {

		label.obj.visible = dot.visible = false;
		controllers.forEach( ( { line } ) => ( line.visible = false ) );
		hit = null;
		setPlace( null );
		setCard( null );

	}

	function setCard( c: typeof onCard ) {

		onCard = c;
		if ( ! pins.dragging ) pins.hoverPart( c?.part ?? null );

	}

	// Grab the card by its top strip with the right trigger (false if the ray isn't on it); it
	// follows the ray until let go.
	function grab() {

		const active = controllers.find( ( { c } ) => c.userData.handedness === 'right' );
		if ( ! active ) return false;
		ray.setFromXRController( active.c );
		return pins.startDrag( ray.ray );

	}

	function release() {

		pins.endDrag();
		sinceLastPick = Infinity;

	}

	function setPlace( p: typeof place ) {

		if ( p?.place !== place?.place ) pins.hover( p?.place ?? null );
		place = p;

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

			label.obj.visible = dot.visible = false;
			ray.setFromXRController( active.c );
			active.line.scale.z = Math.min( menu.hover( ray ) ?? RAY_MAX, RAY_MAX );
			hit = null;
			setPlace( null );
			setCard( null );
			sinceLastPick = Infinity;
			return;

		}

		if ( pins.dragging ) {

			// Every frame, so the card keeps up with the hand.
			label.obj.visible = dot.visible = false;
			ray.setFromXRController( active.c );
			pins.dragTo( ray.ray );
			active.line.scale.z = Math.min( onCard?.distance ?? RAY_MAX, RAY_MAX );
			return;

		}

		sinceLastPick += dt;
		if ( sinceLastPick >= PICK_INTERVAL ) {

			sinceLastPick = 0;
			ray.setFromXRController( active.c );
			// The open card and pins are drawn over everything, so they count even in front of
			// a building; the card covers whatever is behind it.
			setCard( pins.pickCard( ray.ray ) );
			hit = onCard ? null : pointAt( ray );
			setPlace( onCard ? null : pins.pick( ray.ray ) );

		}

		active.line.scale.z = Math.min( onCard?.distance ?? place?.distance ?? hit?.distance ?? RAY_MAX, RAY_MAX );

		const flood = place || onCard ? null : hit?.flood;
		label.obj.visible = dot.visible = !! flood;
		if ( ! flood ) return;

		// Keep the label the same apparent size however far away it is.
		setText( flood.label );
		const dist = headCam.getWorldPosition( head ).distanceTo( flood.point );
		pose( label, flood.point, dist * 0.05, head );
		dot.position.copy( flood.point );
		dot.scale.setScalar( dist * 0.005 );

	}

	// One line per controller, then what the ray is on, for the diagnostics board.
	function status(): string[] {

		const lines = controllers.map( ( { c, line }, i ) => {

			const ray = line.visible ? `○ ${ line.scale.z.toFixed( 1 ) } m` : '×';
			return `手${ i } ${ c.userData.handedness ?? '未接続' }　姿勢${ c.visible ? '○' : '×' }　光線${ ray }${ c.parent ? '' : '（シーン外）' }`;

		} );
		const target = onCard ? ( onCard.part === 'close' ? '札の閉じるボタン' : '札' ) : place ? `ピン ${ place.place.name }` : ! hit ? '-' : hit.flood ? hit.flood.label : hit.distance === Infinity ? 'なし' : `${ hit.distance.toFixed( 0 ) } m 先の建物`;
		return lines.concat( `指す先: ${ target }` );

	}

	return {
		update,
		hide,
		status,
		get hoveredPlace() { return place?.place ?? null; },
		get onCard() { return onCard; },
		grab,
		release,
	};

}

// Above the left controller, tilted back toward the face: the city map, and over it a card
// listing the controls. The diagnostics board takes the card's place when shown.
function createHandPanel( renderer: THREE.WebGLRenderer, rig: THREE.Group, minimap: Minimap, debugBoard: THREE.Mesh, hasMenu: boolean ) {

	const lines = [
		[ '左スティック', '移動' ],
		[ '右スティック', '左右: 向きを変える　上下: 上昇・下降' ],
		[ 'トリガー', '押している間 5 倍速' ],
		[ '右手で指す', '想定浸水深・ピンの名前を表示' ],
		[ 'ピンに右トリガー', '説明を開く（札の × で閉じる）' ],
		[ '札の上部を右トリガー', 'つかんで動かす（離した所に置く）' ],
		[ 'A', '水面を上げる・下げる' ],
		...( hasMenu ? [ [ 'グリップ（右）', '市町村を選ぶ' ] ] : [] ),
		[ 'X', '診断を表示' ],
		[ 'Y', 'スタート地点に戻る' ],
		[ 'B', 'VR を終了' ],
	];
	const canvas = document.createElement( 'canvas' );
	const ctx = canvas.getContext( '2d' )!;
	const pad = 36, row = 64, keyWidth = 340;
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
		ctx.fillText( key, pad, y, keyWidth - 20 );
		ctx.font = '40px system-ui, sans-serif';
		ctx.fillStyle = '#ffffff';
		ctx.fillText( action, pad + keyWidth, y );

	} );

	const texture = new THREE.CanvasTexture( canvas );
	texture.colorSpace = THREE.SRGBColorSpace;
	const width = 0.16; // m
	const cardHeight = width * canvas.height / canvas.width;
	const card = new THREE.Mesh(
		new THREE.PlaneGeometry( width, cardHeight ),
		new THREE.MeshBasicMaterial( { map: texture, transparent: true, depthTest: false } ),
	);
	card.renderOrder = 1000;

	// The pieces stack up the tilted panel from its bottom edge: map, then card or board.
	const GAP = 0.01; // m
	const panel = new THREE.Group();
	panel.position.set( 0, 0.05, - 0.05 );
	panel.rotation.x = - Math.PI / 6;
	panel.visible = false;
	panel.add( minimap.object, card, debugBoard );

	const controllers = [ 0, 1 ].map( i => {

		const c = renderer.xr.getController( i );
		rig.add( c );
		return c;

	} );

	function update( showDebug: boolean ) {

		const left = controllers.find( c => c.userData.handedness === 'left' );
		if ( left && panel.parent !== left ) left.add( panel );
		panel.visible = !! left;
		// The map's height is known once it has been drawn for the city.
		const mapHeight = minimap.height;
		minimap.object.position.y = mapHeight / 2;
		card.position.y = mapHeight + GAP + cardHeight / 2;
		const boardHeight = ( debugBoard.geometry as THREE.PlaneGeometry ).parameters.height;
		debugBoard.position.set( 0, mapHeight + GAP + boardHeight / 2, 0 );
		card.visible = ! showDebug;
		debugBoard.visible = showDebug;

	}

	return { update };

}
