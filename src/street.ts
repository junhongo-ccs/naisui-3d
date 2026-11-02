import * as THREE from 'three';
import type { OrbitControls } from 'three/addons/controls/OrbitControls.js';

// Looking around from the street on a phone: the camera stands at eye height on a street and turns
// as the phone is turned (its orientation sensor), like a window onto the town; a sideways drag
// turns it too (for sitting down), and without the sensor a drag turns and tilts it. A tap on the
// ground walks there (src/main.ts). Leaving goes back to the view from above as it was.
// The heading is relative: when the sensor first reports, the view keeps facing the way it was
// (down the street), whichever way the phone points. Compass headings differ by browser and
// need calibrating, and facing down the street is what matters here.

const EYE_HEIGHT = 1.6; // m
const WALK_TIME = 0.6; // s to glide to a tapped point
const DRAG_TURN = 0.005; // rad per px
const HEAD_ROOM = 2; // m above the feet: the floor is the first surface below this
const FLOOR_CHECK = 0.3; // s between looking up the floor
const MAX_STEP = 20; // m: a floor farther than this from the feet is a coarse tile's, not the street's

type Options = {
	camera: THREE.PerspectiveCamera,
	controls: OrbitControls,
	canvas: HTMLElement,
	groundTargets: () => THREE.Object3D[],
	bounds: () => THREE.Box3,
	// Where to stand and which way to face when entering: the city's start point, if it has one.
	startPose: () => { position: THREE.Vector3, yaw: number } | null,
};

export function createStreetView( { camera, controls, canvas, groundTargets, bounds, startPose }: Options ) {

	let active = false;
	const feet = new THREE.Vector3();
	let walk: { from: THREE.Vector3, to: THREE.Vector3, t: number } | null = null;
	// The view from above, to go back to.
	const saved = { position: new THREE.Vector3(), target: new THREE.Vector3() };

	// Which way the view faces: yaw (turned left from north) and pitch (up from level), from drags;
	// with the sensor, its rotation turned by `yaw` instead.
	let yaw = 0, pitch = 0;
	let device: THREE.Quaternion | null = null; // the phone's rotation, as last reported
	let yawOffset: number | null = null; // turns the phone's heading onto the view's

	async function enter() {

		// iPhone asks the user first, and only from a tap: this must run in the button's handler.
		const ask = ( DeviceOrientationEvent as unknown as { requestPermission?: () => Promise<string> } ).requestPermission;
		const allowed = ask ? ask().then( r => r === 'granted' ).catch( () => false ) : Promise.resolve( true );
		saved.position.copy( camera.position );
		saved.target.copy( controls.target );
		controls.enabled = false;
		const pose = startPose();
		if ( pose ) {

			feet.copy( pose.position );
			yaw = pose.yaw;

		} else {

			const { x, z } = controls.target;
			feet.set( x, floorAt( x, 5000, z ) ?? controls.target.y, z );
			const toward = controls.target.clone().sub( camera.position );
			yaw = Math.atan2( - toward.x, - toward.z );

		}

		pitch = 0;
		sinceFloor = FLOOR_CHECK;
		device = null;
		yawOffset = null;
		walk = null;
		active = true;
		if ( await allowed ) window.addEventListener( 'deviceorientation', onOrientation );

	}

	function exit() {

		if ( ! active ) return;
		active = false;
		window.removeEventListener( 'deviceorientation', onOrientation );
		camera.position.copy( saved.position );
		controls.target.copy( saved.target );
		controls.enabled = true;
		controls.update();

	}

	// Device orientation (Z-X'-Y'' Euler angles of the phone in an east-north-up frame) to the
	// camera's rotation in the scene (x = east, y = up, z = south), for the screen's rotation.
	const euler = new THREE.Euler();
	const toCamera = new THREE.Quaternion( - Math.SQRT1_2, 0, 0, Math.SQRT1_2 ); // looks out of the back of the phone
	const screenTurn = new THREE.Quaternion();
	const Z = new THREE.Vector3( 0, 0, 1 );
	function onOrientation( e: DeviceOrientationEvent ) {

		if ( e.alpha === null || e.beta === null || e.gamma === null ) return;
		const DEG = Math.PI / 180;
		euler.set( e.beta * DEG, e.alpha * DEG, - e.gamma * DEG, 'YXZ' );
		device ??= new THREE.Quaternion();
		device.setFromEuler( euler ).multiply( toCamera )
			.multiply( screenTurn.setFromAxisAngle( Z, - ( screen.orientation?.angle ?? 0 ) * DEG ) );

	}

	const Y = new THREE.Vector3( 0, 1, 0 );
	const forward = new THREE.Vector3();
	const turn = new THREE.Quaternion();
	const target = new THREE.Quaternion();
	function update( dt: number ) {

		if ( walk ) {

			walk.t = Math.min( 1, walk.t + dt / WALK_TIME );
			const k = walk.t * walk.t * ( 3 - 2 * walk.t );
			feet.lerpVectors( walk.from, walk.to, k );
			if ( walk.t === 1 ) walk = null;

		} else {

			// Stand on the ground as it loads: the first tiles are coarse, and their surface can be
			// meters off the start point's known elevation. Looked up a few times a second (the
			// raycast is heavy), as in VR.
			sinceFloor += dt;
			if ( sinceFloor >= FLOOR_CHECK ) {

				sinceFloor = 0;
				// A coarse tile that spans the whole region sags kilometers below it, bowed by the
				// Earth: ignore what is far from where the feet are.
				const floor = floorUnder( feet.x, feet.y, feet.z );
				if ( floor !== null && Math.abs( floor - feet.y ) < MAX_STEP ) feet.y = floor;

			}

		}

		camera.position.copy( feet ).setY( feet.y + EYE_HEIGHT );
		if ( device ) {

			if ( yawOffset === null ) {

				// Keep facing the way the view faced before the sensor's first report.
				forward.set( 0, 0, - 1 ).applyQuaternion( device );
				yawOffset = yaw - Math.atan2( - forward.x, - forward.z );

			}

			target.copy( turn.setFromAxisAngle( Y, yawOffset ) ).multiply( device );

		} else {

			target.setFromEuler( euler.set( pitch, yaw, 0, 'YXZ' ) );

		}

		// The sensor jitters: ease towards it.
		camera.quaternion.slerp( target, 1 - Math.exp( - dt * 25 ) );

	}

	// Walk to a point on the ground (a tap), within the area.
	function moveTo( point: THREE.Vector3 ) {

		const to = point.clone().clamp( bounds().min, bounds().max );
		to.y = floorUnder( to.x, point.y, to.z ) ?? point.y;
		walk = { from: feet.clone(), to, t: 0 };

	}

	const ray = new THREE.Raycaster();
	ray.firstHitOnly = true;
	function floorAt( x: number, fromY: number, z: number ): number | null {

		ray.set( new THREE.Vector3( x, fromY, z ), new THREE.Vector3( 0, - 1, 0 ) );
		return ray.intersectObjects( groundTargets(), true )[ 0 ]?.point.y ?? null;

	}

	// The floor under feet at (x, y, z): the first surface below head height, so standing under a
	// tree or a bridge doesn't lift the view onto it; if there is none, the feet are inside the
	// ground (its surface faces up, so a ray from inside misses it), and the floor is above.
	let sinceFloor = 0;
	function floorUnder( x: number, y: number, z: number ): number | null {

		return floorAt( x, y + HEAD_ROOM, z ) ?? floorAt( x, 5000, z );

	}

	// Turning by dragging: sideways turns (with the sensor too, to face somewhere without turning
	// round in the chair); up and down tilts, without the sensor.
	let last: { x: number, y: number } | null = null;
	canvas.addEventListener( 'pointerdown', e => {

		if ( active && e.isPrimary ) last = { x: e.clientX, y: e.clientY };

	} );
	canvas.addEventListener( 'pointermove', e => {

		if ( ! active || ! last || ! e.isPrimary ) return;
		const dx = e.clientX - last.x, dy = e.clientY - last.y;
		last = { x: e.clientX, y: e.clientY };
		// Dragging the scene: it follows the finger, so the view turns the other way.
		if ( yawOffset !== null ) yawOffset += dx * DRAG_TURN;
		yaw += dx * DRAG_TURN;
		pitch = THREE.MathUtils.clamp( pitch + dy * DRAG_TURN, - 1.4, 1.4 );

	} );
	const release = () => ( last = null );
	canvas.addEventListener( 'pointerup', release );
	canvas.addEventListener( 'pointercancel', release );

	return { enter, exit, update, moveTo, get active() { return active; } };

}
