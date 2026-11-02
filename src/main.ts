import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { VRButton } from 'three/addons/webxr/VRButton.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { OBB, TilesRenderer, WGS84_ELLIPSOID } from '3d-tiles-renderer/three';
import { GLTFExtensionsPlugin } from '3d-tiles-renderer/three/plugins';
import { acceleratedRaycast, computeBoundsTree } from 'three-mesh-bvh';
import catalog from './data/cities.json';
import { depthColor, featureLabel, parseDepthLabel, surfaceHeight } from './flood';
import { BASE_MAPS, createGoogleTiles, createTerrain, maskTo, type BaseMapKey } from './terrain';
import { initVR } from './vr';
import { createLoadingIndicator } from './loading';
import { AREA, ONLY_CITY, VR_START } from './config';
import { createPins, placesFor, type Place } from './places';
import { createScreenPins } from './screen-pins';
import { createPlaceDialog } from './place-dialog';
import { createStreetView } from './street';
import { createMinimap } from './vr-minimap';
import { offerInstall } from './install';
import './style.css';

type City = ( typeof catalog.cities )[ number ];

const DEG = Math.PI / 180;
const params = new URLSearchParams( location.search );
const $ = <T extends HTMLElement>( sel: string ) => document.querySelector( sel ) as T;
// With a Google Map Tiles API key (in .env, never committed), Google's photorealistic 3D tiles
// stand in for the GSI terrain and the PLATEAU buildings; without one, those are used.
const GOOGLE_KEY: string | undefined = import.meta.env.VITE_GOOGLE_MAPS_API_KEY || undefined;
// Whether Google's tiles are in use: there is a key, and they haven't failed to load (the day's
// quota used up, say), in which case the GSI terrain and PLATEAU buildings take over.
let useGoogle = !! GOOGLE_KEY;
// A touch screen (a phone or tablet; or ?ui=touch, to try it on a PC): the title and heading a
// step smaller, the legend folded, a d-pad on the street (style.css). The tiles load lighter there,
// too (addTiles, the loop): a phone's memory for the GPU is small, and textures that no longer
// fit draw black. (On any flat screen, PC or phone, the pins' labels and descriptions are HTML:
// src/screen-pins.ts, src/place-dialog.ts. VR has its own, in the scene.)
const touchUI = params.get( 'ui' ) === 'touch' || ( params.get( 'ui' ) !== 'desktop' && matchMedia( '(pointer: coarse)' ).matches );
// Memory for the tiles kept loaded, per tileset, on a touch screen: a third of the library's
// default (0.3–0.4 GB). iPhone's Safari closes a page that grows past its (small) limit, and
// after the second time shows "問題が繰り返し起きました".
const TOUCH_CACHE = { min: 100e6, max: 150e6 }; // bytes

const cities = ONLY_CITY ? catalog.cities.filter( c => c.code === ONLY_CITY ) : catalog.cities;
// 鎌倉市: hilly with valleys, close to the Shinagawa PoC area's terrain.
const DEFAULT_CITY = ( cities.find( c => c.code === '14204' ) ?? cities[ 0 ] ).code;
let city: City = cities.find( c => c.code === ( params.get( 'city' ) ?? DEFAULT_CITY ) ) ?? cities.find( c => c.code === DEFAULT_CITY )!;

// Picking (tap, VR pointer) raycasts the dense flood meshes; without an index three.js tests every
// triangle, which is too slow to do several times a second on a headset.
THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.Mesh.prototype.raycast = acceleratedRaycast;

function indexForRaycast<T extends TilesRenderer>( tiles: T ): T {

	tiles.addEventListener( 'load-model', ( { scene: model }: { scene: THREE.Object3D } ) => model.traverse( obj => {

		if ( ( obj as THREE.Mesh ).isMesh ) ( obj as THREE.Mesh ).geometry.computeBoundsTree();

	} ) );
	return tiles;

}

// ─── renderer / scene ───────────────────────────────────────────────────────
const renderer = new THREE.WebGLRenderer( { antialias: true, logarithmicDepthBuffer: true } );
renderer.setPixelRatio( Math.min( window.devicePixelRatio, 2 ) );
renderer.setSize( window.innerWidth, window.innerHeight );
renderer.xr.enabled = true;
document.body.appendChild( renderer.domElement );

const scene = new THREE.Scene();
scene.background = new THREE.Color( '#cfe3f2' );
scene.add( new THREE.HemisphereLight( '#ffffff', '#8a8f7a', 2.2 ) );
const sun = new THREE.DirectionalLight( '#ffffff', 1.6 );
sun.position.set( 0.6, 1, 0.3 );
scene.add( sun );

// Everything georeferenced lives under `world`, which maps ECEF onto a local frame centered on
// the city: x = east, y = up, z = south (meters), with y = 0 at the lowest flood polygon.
const world = new THREE.Group();
world.matrixAutoUpdate = false;
scene.add( world );

function placeWorld() {

	const enu = new THREE.Matrix4();
	WGS84_ELLIPSOID.getEastNorthUpFrame( city.lat * DEG, city.lon * DEG, city.groundHeight, enu );
	world.matrix.makeRotationX( - Math.PI / 2 ).multiply( enu.invert() );
	world.matrixWorldNeedsUpdate = true;

}

placeWorld();

// Scene position of a point given by latitude, longitude and height above the geoid, and back.
function toLocal( lat: number, lon: number, elevation: number ) {

	return WGS84_ELLIPSOID.getCartographicToPosition( lat * DEG, lon * DEG, elevation + city.geoidHeight, new THREE.Vector3() ).applyMatrix4( world.matrix );

}

const ecef = new THREE.Vector3();
const toECEF = new THREE.Matrix4();
const cartographic = { lat: 0, lon: 0, height: 0 };
function toLatLon( p: THREE.Vector3 ) {

	ecef.copy( p ).applyMatrix4( toECEF.copy( world.matrix ).invert() );
	WGS84_ELLIPSOID.getPositionToCartographic( ecef, cartographic );
	return { lat: cartographic.lat / DEG, lon: cartographic.lon / DEG };

}

// The part of the city shown: config AREA, or the whole flood area. [west, south, east, north].
function cityArea() {

	return AREA[ city.code ] ?? city.bounds as [ number, number, number, number ];

}

function inArea( lat: number, lon: number ) {

	const [ west, south, east, north ] = cityArea();
	return lon >= west && lon <= east && lat >= south && lat <= north;

}

// Where the VR rig may go: over the area and a little beyond, up to MAX_ALTITUDE.
const BOUNDS_MARGIN = 100; // m
const MAX_ALTITUDE = 2000; // m
function cityBounds() {

	const [ west, south, east, north ] = cityArea();
	const box = new THREE.Box3().setFromPoints( [ toLocal( south, west, 0 ), toLocal( north, east, 0 ) ] );
	box.min.y = - 200;
	box.max.y = MAX_ALTITUDE;
	return box.expandByVector( new THREE.Vector3( BOUNDS_MARGIN, 0, BOUNDS_MARGIN ) );

}

let bounds = cityBounds();

// Only where the user can go is shown, and loaded: the ground and flood tiles load within the
// bounds, and everything is cut off at the bounds' sides, so the coarse tiles that reach beyond
// (to Ofuna, Zushi) don't show past them. Seen from above, the town stands cut out like a model.
// In ECEF, the tiles' own frame.
function terrainArea() {

	const box = bounds.clone();
	box.min.y = - 500;
	return new OBB( box, world.matrix.clone().invert() );

}

// The four sides of the bounds, as clipping planes (each keeps what is on its normal's side).
const clipPlanes = [
	new THREE.Plane( new THREE.Vector3( 1, 0, 0 ) ), new THREE.Plane( new THREE.Vector3( - 1, 0, 0 ) ),
	new THREE.Plane( new THREE.Vector3( 0, 0, 1 ) ), new THREE.Plane( new THREE.Vector3( 0, 0, - 1 ) ),
];
function clipToBounds() {

	clipPlanes[ 0 ].constant = - bounds.min.x;
	clipPlanes[ 1 ].constant = bounds.max.x;
	clipPlanes[ 2 ].constant = - bounds.min.z;
	clipPlanes[ 3 ].constant = bounds.max.z;

}

clipToBounds();
renderer.clippingPlanes = clipPlanes;

const camera = new THREE.PerspectiveCamera( 55, window.innerWidth / window.innerHeight, 0.1, 2e6 );
const rig = new THREE.Group();
rig.add( camera );
scene.add( rig );

// Size of the area in meters.
function cityExtent() {

	const [ west, south, east, north ] = cityArea();
	return Math.max( ( east - west ) * 111e3 * Math.cos( city.lat * DEG ), ( north - south ) * 111e3 );

}

// The middle of the area, on the y = 0 plane.
function areaCenter() {

	const [ west, south, east, north ] = cityArea();
	return toLocal( ( south + north ) / 2, ( west + east ) / 2, 0 ).setY( 0 );

}

const controls = new OrbitControls( camera, renderer.domElement );
controls.enableDamping = true;
controls.maxPolarAngle = Math.PI * 0.49;
controls.minDistance = 20;
controls.screenSpacePanning = false;

// Look down over the area from the south.
let framedCity = '';
function frameCity() {

	const extent = cityExtent();
	const center = areaCenter();
	camera.position.set( 0, extent * 0.6, extent * 0.75 ).add( center );
	controls.target.copy( center );
	controls.maxDistance = extent * 4;
	controls.update();
	framedCity = city.code;

}

frameCity();

// ─── tilesets ───────────────────────────────────────────────────────────────
// PLATEAU b3dm tiles are Draco-compressed glTF with CESIUM_RTC centers. Google's tiles are Draco too.
const dracoLoader = new DRACOLoader().setDecoderPath( 'https://www.gstatic.com/draco/versioned/decoders/1.5.7/' );

const DEFAULT_BASE: BaseMapKey = 'photo';
let baseMap: BaseMapKey = ( params.get( 'base' ) as BaseMapKey ) in BASE_MAPS ? params.get( 'base' ) as BaseMapKey : DEFAULT_BASE;
// The ground: GSI terrain, or Google's 3D tiles (ground and buildings in one).
function createGround() {

	if ( ! GOOGLE_KEY || ! useGoogle ) return createTerrain( city.geoidHeight, baseMap, terrainArea() );
	const tiles = createGoogleTiles( GOOGLE_KEY, terrainArea(), dracoLoader );
	// The root tileset is refused when the day's quota is used up (or the key is): show the GSI
	// terrain and PLATEAU buildings instead of nothing. Not from inside the renderer's own event.
	tiles.addEventListener( 'load-error', ( { tile } ) => {

		if ( tile === null ) setTimeout( fallBackFromGoogle );

	} );
	return tiles;

}

function fallBackFromGoogle() {

	if ( ! useGoogle ) return;
	useGoogle = false;
	world.remove( terrain.group );
	terrain.dispose();
	terrain = addTiles( createGround() );
	buildings = createBuildings();
	renderGroundUI();

}

let terrain = addTiles( createGround() );

function plateauTiles( url: string ) {

	const tiles = new TilesRenderer( url );
	tiles.registerPlugin( new GLTFExtensionsPlugin( { rtc: true, dracoLoader } ) );
	return addTiles( tiles );

}

let buildings: TilesRenderer[] = [];
let floods: TilesRenderer[] = [];

// Per-dataset legend: depth label → parsed range.
const legend = new Map<string, Map<string, [ number, number ] | null>>();

const floodMaterial = new THREE.MeshBasicMaterial( {
	vertexColors: true,
	transparent: true,
	opacity: 0.8,
	side: THREE.DoubleSide,
	depthWrite: false,
	// The polygons are draped on almost the same DEM as the terrain; pull them forward.
	polygonOffset: true,
	polygonOffsetFactor: - 8,
	polygonOffsetUnits: - 8,
} );

// Raise each polygon by its depth so the layer reads as a water surface. Done in the vertex shader
// (per-vertex `lift` in meters × `waterLevel` 0..1) so it can be toggled and animated cheaply.
// Scene y is up, and the tiles are unscaled, so the scene's up turned into model space is the offset.
const waterLevel = { value: 0 };
let waterTarget = 0;
floodMaterial.onBeforeCompile = shader => {

	shader.uniforms.waterLevel = waterLevel;
	shader.vertexShader = shader.vertexShader
		.replace( '#include <common>', '#include <common>\nattribute float lift;\nuniform float waterLevel;' )
		.replace( '#include <begin_vertex>', '#include <begin_vertex>\ntransformed += normalize( transpose( mat3( modelMatrix ) ) * vec3( 0.0, 1.0, 0.0 ) ) * lift * waterLevel;' );

};

function setWaterRaised( on: boolean ) {

	setWaterTarget( on ? 1 : 0 );

}

// Raise or lower the water by a fraction of full depth (VR: A / B held); it stops where left.
function adjustWater( delta: number ) {

	setWaterTarget( THREE.MathUtils.clamp( waterTarget + delta, 0, 1 ) );

}

function setWaterTarget( target: number ) {

	waterTarget = target;
	$<HTMLInputElement>( '#raise-water' ).checked = target > 0;

}

function floodTiles( f: City[ 'floods' ][ number ], i: number ) {

	const tiles = indexForRaycast( plateauTiles( f.url ) );
	maskTo( tiles, terrainArea() );
	tiles.errorTarget = 4;
	tiles.group.visible = i === 0;
	tiles.group.renderOrder = 10;
	const labels = new Map<string, [ number, number ] | null>();
	legend.set( f.id, labels );

	tiles.addEventListener( 'load-model', ( { scene: model }: { scene: THREE.Object3D & { batchTable?: any } } ) => {

		const table = model.batchTable;
		const rankOrg: unknown[] = table?.getPropertyArray( 'uro:rankOrg' ) ?? [];
		const rank: unknown[] = table?.getPropertyArray( 'uro:rank' ) ?? [];
		const colors: THREE.Color[] = [];
		const lifts: number[] = [];
		const featureLabels: string[] = [];
		const count = Math.max( rankOrg.length, rank.length );
		for ( let id = 0; id < count; id ++ ) {

			const label = featureLabel( rankOrg[ id ], rank[ id ] );
			const range = parseDepthLabel( label );
			labels.set( label, range );
			featureLabels.push( label );
			colors.push( depthColor( range ) );
			lifts.push( surfaceHeight( range ) );

		}

		model.traverse( obj => {

			const mesh = obj as THREE.Mesh;
			if ( ! mesh.isMesh ) return;
			const geom = mesh.geometry;
			const ids = geom.getAttribute( '_batchid' );
			const n = geom.getAttribute( 'position' ).count;
			const buf = new Float32Array( n * 3 );
			const lift = new Float32Array( n );
			for ( let v = 0; v < n; v ++ ) {

				const id = ids ? ids.getX( v ) : 0;
				const c = colors[ id ] ?? depthColor( null );
				buf.set( [ c.r, c.g, c.b ], v * 3 );
				lift[ v ] = lifts[ id ] ?? 0;

			}

			geom.setAttribute( 'color', new THREE.BufferAttribute( buf, 3 ) );
			geom.setAttribute( 'lift', new THREE.BufferAttribute( lift, 1 ) );
			mesh.material = floodMaterial;
			mesh.renderOrder = 10;
			mesh.userData.featureLabels = featureLabels;

		} );

		renderLegend();

	} );

	return tiles;

}

function createBuildings() {

	const showBuildings = $<HTMLInputElement>( '#show-buildings' ).checked;
	// Google's tiles have the buildings already.
	return useGoogle ? [] : city.buildings.map( b => {

		const tiles = plateauTiles( b.url );
		tiles.errorTarget = 8;
		tiles.group.visible = showBuildings;
		return tiles;

	} );

}

function loadCityTiles() {

	buildings = createBuildings();
	floods = city.floods.map( floodTiles );

}

loadCityTiles();

// Landmarks and shelters, as pins in the scene and dots on the VR hand map.
const pins = createPins();
scene.add( pins.group );
const minimap = createMinimap();
// On a flat screen the pins' labels are HTML over the view and a pin's description opens as a
// modal (the type scale's sizes, the browser's zoom); in VR both are in the scene.
const pinLayer = $( '#pin-layer' );
const screenPins = createScreenPins( pinLayer );
const placeDialog = createPlaceDialog( () => screenPins.setActive( null ) );
function openPlace( place: Place ) {

	screenPins.setActive( place );
	placeDialog.open( place, city.city );

}

// A tap on pins gathered into one disc closes in on them, until they stand apart on screen; if
// they are still together up close, they are listed to choose from.
const CLOSE_ENOUGH = 120; // m from the view's center: closer than this, list them
const SPREAD = 9; // view distance per meter between the closest two, to set them about 40 px apart
function openCluster( places: Place[] ) {

	const bases = places.map( p => pins.heads().find( h => h.place === p )!.base );
	const center = bases.reduce( ( c, b ) => c.add( b ), new THREE.Vector3() ).divideScalar( bases.length );
	let closest = Infinity;
	for ( let i = 0; i < bases.length; i ++ ) for ( let j = i + 1; j < bases.length; j ++ ) closest = Math.min( closest, bases[ i ].distanceTo( bases[ j ] ) );
	const distance = camera.position.distanceTo( controls.target );
	if ( street.active || distance < CLOSE_ENOUGH ) {

		placeDialog.openList( places, openPlace );
		return;

	}

	flyTo( center, THREE.MathUtils.clamp( closest * SPREAD, CLOSE_ENOUGH * 0.6, distance * 0.6 ) );

}

// Glide the view from above to look at `target` from `distance`, from the same direction.
const FLY_TIME = 0.8; // s
let fly: { fromPosition: THREE.Vector3, fromTarget: THREE.Vector3, toPosition: THREE.Vector3, toTarget: THREE.Vector3, t: number } | null = null;
function flyTo( target: THREE.Vector3, distance: number ) {

	const toward = camera.position.clone().sub( controls.target ).normalize();
	fly = {
		fromPosition: camera.position.clone(), fromTarget: controls.target.clone(),
		toPosition: target.clone().addScaledVector( toward, distance ), toTarget: target.clone(), t: 0,
	};

}

function updateFly( dt: number ) {

	if ( ! fly ) return;
	fly.t = Math.min( 1, fly.t + dt / FLY_TIME );
	const k = fly.t * fly.t * ( 3 - 2 * fly.t );
	camera.position.lerpVectors( fly.fromPosition, fly.toPosition, k );
	controls.target.lerpVectors( fly.fromTarget, fly.toTarget, k );
	if ( fly.t === 1 ) fly = null;

}

// Looking around from the street on a PC or phone (src/street.ts).
const street = createStreetView( {
	camera, controls, canvas: renderer.domElement,
	groundTargets: () => raycastTargets( [ terrain, ...buildings ] ),
	bounds: () => bounds,
	startPose: vrStartPose,
} );

function loadPlaces() {

	const places = placesFor( city.code ).filter( p => inArea( p.lat, p.lon ) );
	pins.setPlaces( city.city, places, toLocal );
	screenPins.setPlaces( places );
	minimap.setCity( cityArea(), places );

}

loadPlaces();

// Where VR starts in this city (config VR_START).
function vrStartPose() {

	const start = VR_START[ city.code ];
	if ( ! start ) return null;
	const position = toLocal( ...start.at, start.elevation );
	const toward = toLocal( ...start.facing, start.elevation ).sub( position );
	// The rig looks along -z (north) at yaw 0, and turns counterclockwise seen from above.
	return { position, yaw: Math.atan2( - toward.x, - toward.z ) };

}

// Swap in another city without reloading the page, so a VR session survives it.
function switchCity( code: string ) {

	const next = cities.find( c => c.code === code );
	if ( ! next || next === city ) return;
	city = next;
	for ( const t of allTiles() ) {

		world.remove( t.group );
		t.dispose();

	}

	legend.clear();
	placeWorld();
	bounds = cityBounds();
	clipToBounds();
	terrain = addTiles( createGround() );
	loadCityTiles();
	loadPlaces();
	renderCityUI();
	renderLegend();
	$( '#info' ).hidden = true;
	if ( renderer.xr.isPresenting ) {

		// Arrive above the flood area, south of its center, facing north.
		const extent = cityExtent();
		vr.arrive( new THREE.Vector3( 0, THREE.MathUtils.clamp( extent * 0.1, 100, 400 ), extent * 0.3 ) );

	} else {

		leaveStreet();
		frameCity();

	}

}

function addTiles( tiles: TilesRenderer ) {

	tiles.setCamera( camera );
	tiles.setResolutionFromRenderer( camera, renderer );
	if ( touchUI ) {

		tiles.lruCache.minBytesSize = TOUCH_CACHE.min;
		tiles.lruCache.maxBytesSize = TOUCH_CACHE.max;

	}

	world.add( tiles.group );
	return tiles;

}

function allTiles() {

	return [ terrain, ...buildings, ...floods ];

}

function setBaseMap( key: BaseMapKey ) {

	baseMap = key;
	world.remove( terrain.group );
	terrain.dispose();
	terrain = addTiles( createTerrain( city.geoidHeight, key, terrainArea() ) );
	syncURL();

}

// ─── UI ─────────────────────────────────────────────────────────────────────

// Keep in the URL what the page shows that it wouldn't open with, so a link or a reload opens the
// same view and the plain URL stays plain: the city, when there is a choice of cities; the base
// map, when the GSI terrain is shown (Google's tiles have none to choose); ?ui= if it was given.
function syncURL() {

	const q = new URLSearchParams();
	if ( cities.length > 1 && city.code !== DEFAULT_CITY ) q.set( 'city', city.code );
	if ( ! useGoogle && baseMap !== DEFAULT_BASE ) q.set( 'base', baseMap );
	if ( params.has( 'ui' ) ) q.set( 'ui', params.get( 'ui' )! );
	const search = q.toString();
	history.replaceState( null, '', location.pathname + ( search ? `?${ search }` : '' ) + location.hash );

}

// The controls and credits that depend on whose ground is shown. When Google's tiles have failed,
// the credits say why the GSI terrain is shown instead.
function renderGroundUI() {

	$( '#base' ).closest( 'label' )!.hidden = useGoogle;
	$( '#show-buildings' ).closest( 'label' )!.hidden = useGoogle;
	$( '#google-attribution' ).hidden = ! useGoogle;
	$( '#ground-note' ).hidden = useGoogle || ! GOOGLE_KEY;

}

function buildUI() {

	const citySel = $<HTMLSelectElement>( '#city' );
	citySel.closest( 'label' )!.hidden = cities.length < 2;
	for ( const c of cities ) {

		citySel.add( new Option( `${ c.pref } ${ c.city }`, c.code, false, c.code === city.code ) );

	}

	citySel.addEventListener( 'change', () => switchCity( citySel.value ) );

	const baseSel = $<HTMLSelectElement>( '#base' );
	renderGroundUI();
	for ( const [ key, b ] of Object.entries( BASE_MAPS ) ) baseSel.add( new Option( b.label, key, false, key === baseMap ) );
	baseSel.addEventListener( 'change', () => setBaseMap( baseSel.value as BaseMapKey ) );

	const bldg = $<HTMLInputElement>( '#show-buildings' );
	bldg.addEventListener( 'change', () => buildings.forEach( t => ( t.group.visible = bldg.checked ) ) );

	const opacity = $<HTMLInputElement>( '#opacity' );
	opacity.addEventListener( 'input', () => ( floodMaterial.opacity = Number( opacity.value ) ) );

	const raise = $<HTMLInputElement>( '#raise-water' );
	raise.addEventListener( 'change', () => setWaterRaised( raise.checked ) );

	$( '#panel-toggle' ).addEventListener( 'click', () => document.body.classList.toggle( 'panel-closed' ) );

	if ( touchUI ) {

		document.body.classList.add( 'touch-ui' );
		// The legend starts folded to a strip of its colors; a tap opens or folds it.
		const legendBox = $( '#legend' );
		const setFolded = ( folded: boolean ) => {

			legendBox.classList.toggle( 'folded', folded );
			legendBox.setAttribute( 'aria-expanded', String( ! folded ) );

		};
		legendBox.setAttribute( 'role', 'button' );
		legendBox.tabIndex = 0;
		setFolded( true );
		legendBox.addEventListener( 'click', () => setFolded( ! legendBox.classList.contains( 'folded' ) ) );
		setupStick();

	}

	const enter = $<HTMLButtonElement>( '#street-enter' );
	enter.hidden = false;
	gateStreetButton( false );
	enter.addEventListener( 'click', () => {

		fly = null;
		street.enter();
		document.body.classList.add( 'in-street' );
		$( '#info' ).hidden = true;
		$( '#street-hint' ).textContent = touchUI
			? '左半分: 押したまま動かして歩く ・ 右半分: ドラッグで見回す（スマホを動かしても見回せる）'
			: 'ドラッグで見回す ・ W A S D（矢印キー）で歩く、Shift で速く ・ 地面をクリックでそこへ移動';

	} );
	$( '#street-exit' ).addEventListener( 'click', leaveStreet );
	// VR remembers the view to come back to as it starts: leave the street first (this listener is
	// added before VR's).
	renderer.xr.addEventListener( 'sessionstart', leaveStreet );
	// On a phone (narrow, or held sideways and so short) the panel starts folded, to leave the map.
	if ( window.innerWidth < 640 || window.innerHeight < 500 ) document.body.classList.add( 'panel-closed' );

	offerInstall();

	// The folded credits line on a phone (style.css) opens on a tap; the first tap only opens it,
	// rather than following a link it happened to land on.
	const credits = $( '#attribution' );
	const folded = matchMedia( '(max-width: 640px), (max-height: 500px)' );
	credits.addEventListener( 'click', e => {

		if ( ! folded.matches ) return;
		if ( ! credits.classList.contains( 'open' ) ) {

			e.preventDefault();
			credits.classList.add( 'open' );

		} else if ( ! ( e.target as HTMLElement ).closest( 'a' ) ) {

			credits.classList.remove( 'open' );

		}

	} );

	// Phones are asked to turn sideways (see #rotate in style.css). Where the browser can lock the
	// orientation (Android, in full screen), a button does it.
	// With the phone's rotation lock on, turning it doesn't turn the page, so the prompt can also
	// be put away to look upright.
	$( '#rotate-dismiss' ).addEventListener( 'click', () => document.body.classList.add( 'rotate-dismissed' ) );
	const lock = $<HTMLButtonElement>( '#rotate-lock' );
	const orientation = screen.orientation as ScreenOrientation & { lock?: ( o: string ) => Promise<void> };
	lock.hidden = ! ( document.fullscreenEnabled && typeof orientation?.lock === 'function' );
	lock.addEventListener( 'click', () => {

		document.documentElement.requestFullscreen()
			.then( () => orientation.lock?.( 'landscape' ) )
			.catch( () => {} );

	} );

	renderCityUI();

}

// As the VR button is: shut until the first load is done, so the view doesn't drop onto ground
// whose first, coarse tiles aren't even in yet.
let streetGateOpen = false;
function gateStreetButton( settled: boolean ) {

	if ( streetGateOpen ) return;
	const button = $<HTMLButtonElement>( '#street-enter' );
	button.disabled = ! settled;
	button.textContent = settled ? 'まちの中から見る' : '読み込み中…';
	streetGateOpen = settled;

}

function leaveStreet() {

	street.exit();
	document.body.classList.remove( 'in-street' );
	$( '#info' ).hidden = true;

}

// Moving with keys (PC) or the stick (phone, on the street): W / ↑ forward, S / ↓ back, A / ← and
// D / → to the side; the stick any way round. From above it slides the map; on the street it
// walks. Held, it speeds up (and Shift makes it fast at once).
const keysDown = new Set<string>();
const KEY_DIRS: Record<string, string> = {
	KeyW: 'up', ArrowUp: 'up', KeyS: 'down', ArrowDown: 'down',
	KeyA: 'left', ArrowLeft: 'left', KeyD: 'right', ArrowRight: 'right',
};
window.addEventListener( 'keydown', e => {

	// Not while typing in a field, choosing in a list, or reading a description.
	const t = e.target instanceof Element ? e.target : null;
	if ( placeDialog.isOpen || t?.closest( 'input, select, textarea' ) || e.ctrlKey || e.metaKey || e.altKey ) return;
	const dir = KEY_DIRS[ e.code ];
	if ( ! dir ) return;
	keysDown.add( dir );
	e.preventDefault(); // the arrows would scroll the panel
	fly = null;

} );
window.addEventListener( 'keyup', e => keysDown.delete( KEY_DIRS[ e.code ] ) );
window.addEventListener( 'blur', () => keysDown.clear() );
let shiftDown = false;
window.addEventListener( 'keydown', e => ( shiftDown = e.shiftKey ) );
window.addEventListener( 'keyup', e => ( shiftDown = e.shiftKey ) );

// The floating stick on a phone, as in games and metaverse apps: the left half of the screen takes
// the thumb (as in most games), the base comes to where it lands, and the way to walk is where the
// thumb has gone from there, any way round (the right half of the view turns it: src/street.ts).
// Let go, it stops, and the base goes back to wait at the bottom left. A thumb that lands on a pin
// opens it instead, as anywhere else.
const STICK_RADIUS = 48; // px: how far the knob goes from the base's middle
const STICK_DEAD = 8; // px from the middle that don't walk
const stick = { x: 0, y: 0 }; // the way, as a unit vector: x to the right, y forward (0, 0 at rest)
function setupStick() {

	const zone = $( '#stick-zone' ), base = $( '#stick-base' ), knob = $( '#stick-knob' );
	let finger: number | null = null;
	let origin = { x: 0, y: 0 };
	let pinTap: ReturnType<typeof screenPins.pick> = null; // a pin under the thumb as it landed
	const reset = () => {

		finger = null;
		pinTap = null;
		stick.x = stick.y = 0;
		zone.classList.remove( 'active' );
		base.style.left = base.style.top = base.style.right = base.style.bottom = '';
		knob.style.transform = '';

	};
	zone.addEventListener( 'pointerdown', e => {

		if ( finger !== null ) return;
		finger = e.pointerId;
		origin = { x: e.clientX, y: e.clientY };
		// Keep the thumb's events while it is down, even if it slides out of the zone.
		try {

			zone.setPointerCapture( e.pointerId );

		} catch {}
		pinTap = screenPins.pick( e.clientX, e.clientY );
		if ( pinTap ) return;
		const r = zone.getBoundingClientRect();
		zone.classList.add( 'active' );
		base.style.left = `${ e.clientX - r.left }px`;
		base.style.top = `${ e.clientY - r.top }px`;
		base.style.right = base.style.bottom = 'auto';

	} );
	zone.addEventListener( 'pointermove', e => {

		if ( e.pointerId !== finger || pinTap ) return;
		const dx = e.clientX - origin.x, dy = e.clientY - origin.y;
		const d = Math.hypot( dx, dy );
		const k = d > STICK_RADIUS ? STICK_RADIUS / d : 1;
		knob.style.transform = `translate(${ dx * k }px, ${ dy * k }px)`;
		stick.x = d > STICK_DEAD ? dx / d : 0;
		stick.y = d > STICK_DEAD ? - dy / d : 0;

	} );
	zone.addEventListener( 'pointerup', e => {

		if ( e.pointerId !== finger ) return;
		const tap = pinTap && Math.hypot( e.clientX - origin.x, e.clientY - origin.y ) <= TAP_SLOP.touch ? pinTap : null;
		reset();
		if ( ! tap ) return;
		if ( 'place' in tap ) openPlace( tap.place );
		else openCluster( tap.cluster );

	} );
	for ( const type of [ 'pointercancel', 'lostpointercapture' ] ) {

		zone.addEventListener( type, e => {

			if ( ( e as PointerEvent ).pointerId === finger ) reset();

		} );

	}

	zone.addEventListener( 'contextmenu', e => e.preventDefault() ); // a long press would open it

}

// The way to move this frame: x to the right, y forward (a unit or zero vector, or each -1..1 from
// keys), and how fast.
const MOVE_RAMP = 3; // s held to reach full speed
let movingFor = 0;
function moveInput( dt: number ) {

	let x = ( keysDown.has( 'right' ) ? 1 : 0 ) - ( keysDown.has( 'left' ) ? 1 : 0 );
	let y = ( keysDown.has( 'up' ) ? 1 : 0 ) - ( keysDown.has( 'down' ) ? 1 : 0 );
	if ( stick.x || stick.y ) ( { x, y } = stick );
	movingFor = x || y ? movingFor + dt : 0;
	// 0 at first, 1 after MOVE_RAMP seconds held, or at once with Shift.
	const boost = shiftDown ? 1 : Math.min( movingFor / MOVE_RAMP, 1 );
	return { x, y, boost };

}

// Slide the view from above over the map: forward is the way the camera faces, flattened. The
// speed goes with how far away the camera is, so it feels the same zoomed in or out.
const PAN_SPEED = 0.4; // of the view distance per second, at first
const forward = new THREE.Vector3(), right = new THREE.Vector3();
function panView( move: { x: number, y: number, boost: number }, dt: number ) {

	if ( ! move.x && ! move.y ) return;
	forward.subVectors( controls.target, camera.position ).setY( 0 ).normalize();
	right.crossVectors( forward, camera.up ).normalize();
	const speed = camera.position.distanceTo( controls.target ) * PAN_SPEED * ( 1 + 3 * move.boost );
	const step = forward.multiplyScalar( move.y ).addScaledVector( right, move.x ).normalize().multiplyScalar( speed * dt );
	const target = controls.target.clone().add( step ).clamp( bounds.min, bounds.max );
	step.subVectors( target, controls.target );
	controls.target.add( step );
	camera.position.add( step );

}

// The parts of the panel that depend on the city.
function renderCityUI() {

	$<HTMLSelectElement>( '#city' ).value = city.code;
	$( '#title' ).textContent = `${ city.pref } ${ city.city }`;
	$( '#floods' ).replaceChildren( ...city.floods.map( ( f, i ) => {

		const row = document.createElement( 'label' );
		row.className = 'check';
		const box = document.createElement( 'input' );
		box.type = 'checkbox';
		box.checked = floods[ i ].group.visible;
		box.addEventListener( 'change', () => {

			floods[ i ].group.visible = box.checked;
			renderLegend();

		} );
		row.append( box, ` ${ f.name }（${ f.year }）` );
		return row;

	} ) );
	syncURL();

}

function renderLegend() {

	const merged = new Map<string, [ number, number ] | null>();
	city.floods.forEach( ( f, i ) => {

		if ( floods[ i ].group.visible ) legend.get( f.id )!.forEach( ( r, l ) => merged.set( l, r ) );

	} );

	const items = [ ...merged ].sort( ( a, b ) => ( a[ 1 ]?.[ 0 ] ?? 99 ) - ( b[ 1 ]?.[ 0 ] ?? 99 ) || ( a[ 1 ]?.[ 1 ] ?? 99 ) - ( b[ 1 ]?.[ 1 ] ?? 99 ) );
	$( '#legend-items' ).replaceChildren( ...items.map( ( [ label, range ] ) => {

		const li = document.createElement( 'li' );
		const sw = document.createElement( 'span' );
		sw.className = 'swatch';
		sw.style.background = `#${ depthColor( range ).getHexString() }`;
		li.append( sw, label );
		return li;

	} ) );
	$( '#legend-depth' ).hidden = items.length === 0;

}

// What to raycast for a set of tilesets. For PLATEAU tiles, the tiles currently in the scene: the
// group's own raycast walks the whole cached tile tree on every call. The terrain must go through its
// group, though: its meshes are flat and displaced on the GPU, and only the terrain plugin's raycast
// (reached via the group) applies the elevation.
function raycastTargets( sets: TilesRenderer[] ) {

	return sets.filter( t => t.group.visible ).flatMap( t => ( t === terrain && ! useGoogle ? [ t.group ] : t.group.children ) );

}

// What a ray points at: the distance to the first surface, and the flood polygon there, if any.
// A flood behind a building doesn't count. The terrain is left out on purpose: in valleys the GSI
// DEM sits a metre or more above the PLATEAU polygons, so from street level the ground would hide
// every flood, and raycasting the GPU-displaced terrain costs several ms per ray.
function pointAt( ray: THREE.Raycaster ) {

	const floodHit = ray.intersectObjects( raycastTargets( floods ), true ).find( h => h.face );
	const solidHit = ray.intersectObjects( raycastTargets( buildings ), true )[ 0 ];
	const distance = Math.min( floodHit?.distance ?? Infinity, solidHit?.distance ?? Infinity );
	if ( ! floodHit || ( solidHit && floodHit.distance > solidHit.distance + 1 ) ) {

		return { distance, flood: null };

	}

	const mesh = floodHit.object as THREE.Mesh;
	const ids = mesh.geometry.getAttribute( '_batchid' );
	const label: string = mesh.userData.featureLabels?.[ ids ? ids.getX( floodHit.face!.a ) : 0 ] ?? '不明';
	// The ray hits the polygon on the ground; put the point on the raised surface the user sees.
	floodHit.point.y += surfaceHeight( parseDepthLabel( label ) ) * waterLevel.value;
	return { distance, flood: { point: floodHit.point, label } };

}

// Tap / click a flood polygon to read its depth.
const raycaster = new THREE.Raycaster();
raycaster.firstHitOnly = true;
const pointer = new THREE.Vector2();
function rayAt( e: PointerEvent ) {

	pointer.set( ( e.clientX / window.innerWidth ) * 2 - 1, - ( e.clientY / window.innerHeight ) * 2 + 1 );
	raycaster.setFromCamera( pointer, camera );
	return raycaster.ray;

}

// A tap: a press and release that moved less than TAP_SLOP. A fingertip rolls a few pixels even
// on a plain tap, more than a mouse does. The pin is picked where the finger came down, among the
// labels as they were then: even a slight roll turns the view (about 9° for 10 px on a phone held
// sideways) and carries the labels off from under the finger.
const TAP_SLOP = { mouse: 6, touch: 12 }; // px
let downAt = { x: 0, y: 0 };
let downPick: ReturnType<typeof screenPins.pick> = null;
renderer.domElement.addEventListener( 'pointerdown', e => {

	downAt = { x: e.clientX, y: e.clientY };
	downPick = screenPins.pick( e.clientX, e.clientY );
	fly = null; // a touch takes the view back from a glide

} );

// A grabbing hand while the view is being dragged (not on a plain click), and a pointing hand
// over a pin's label. OrbitControls writes an inline cursor style, so set it inline too.
const setCursor = ( c: string ) => ( renderer.domElement.style.cursor = c );
renderer.domElement.addEventListener( 'pointermove', e => {

	if ( e.buttons ) {

		if ( Math.hypot( e.clientX - downAt.x, e.clientY - downAt.y ) > 6 ) setCursor( 'grabbing' );

	} else if ( e.pointerType === 'mouse' ) {

		setCursor( screenPins.pick( e.clientX, e.clientY ) ? 'pointer' : 'auto' );

	}

} );

renderer.domElement.addEventListener( 'pointercancel', () => setCursor( 'auto' ) );

renderer.domElement.addEventListener( 'pointerup', e => {

	setCursor( 'auto' );
	const slop = e.pointerType === 'mouse' ? TAP_SLOP.mouse : TAP_SLOP.touch;
	if ( Math.hypot( e.clientX - downAt.x, e.clientY - downAt.y ) > slop ) return;
	rayAt( e );
	const info = $( '#info' );
	const hit = downPick;
	if ( hit ) {

		if ( 'place' in hit ) openPlace( hit.place );
		else openCluster( hit.cluster );
		info.hidden = true;
		return;

	}

	// On the street, a tap on the ground walks there (and, below, says the depth there).
	if ( street.active ) {

		const ground = raycaster.intersectObjects( raycastTargets( [ terrain, ...buildings ] ), true )[ 0 ];
		if ( ground ) street.moveTo( ground.point );

	}

	const { flood } = pointAt( raycaster );
	info.hidden = ! flood;
	if ( flood ) info.textContent = `想定浸水深: ${ flood.label }`;

} );

// The browser can take the GPU away from the page (on a phone, when it runs short of memory): the
// view goes black. Say so and offer a reload, rather than leave a black screen.
renderer.domElement.addEventListener( 'webglcontextlost', () => ( $( '#context-lost' ).hidden = false ) );
renderer.domElement.addEventListener( 'webglcontextrestored', () => ( $( '#context-lost' ).hidden = true ) );
$( '#context-lost-reload' ).addEventListener( 'click', () => location.reload() );

window.addEventListener( 'resize', () => {

	camera.aspect = window.innerWidth / window.innerHeight;
	camera.updateProjectionMatrix();
	renderer.setSize( window.innerWidth, window.innerHeight );
	screenPins.measure(); // the browser's zoom changes the labels' size too

} );

buildUI();

// Handles for poking at the scene from the dev-tools console.
// Getters, since switching cities replaces the tilesets.
if ( import.meta.env.DEV ) {

	Object.assign( window, { app: {
		renderer, scene, world, camera, controls, legend, pins, screenPins, minimap, toLocal, toLatLon,
		get vr() { return vr; },
		get city() { return city; },
		get terrain() { return terrain; },
		get buildings() { return buildings; },
		get floods() { return floods; },
	} } );

}

// ─── VR ─────────────────────────────────────────────────────────────────────
// Only shown where VR can be entered (a headset's browser): on a PC or phone it would just say
// "VR NOT SUPPORTED". The VR line of the help text goes with it.
const vrButton = VRButton.createButton( renderer ) as HTMLButtonElement;
navigator.xr?.isSessionSupported( 'immersive-vr' ).then( ok => {

	if ( ! ok ) return;
	document.body.appendChild( vrButton );
	$( '#vr-hint' ).hidden = false;

} ).catch( () => {} );

// Keep the VR button shut until the city, and the buildings at the VR start point, have first
// loaded: entering on half-loaded tiles shows a flat photo where the buildings should be. There
// is no time limit; on a slow line the wait is long (~40 s on a fast one), but it ends. Failed
// tiles stop loading too, so they don't hold it shut. VRButton writes 'ENTER VR' once it knows
// VR is supported; only then is there anything to hold back.
let vrGateOpen = false;
function gateVRButton( settled: boolean ) {

	if ( vrGateOpen || ( vrButton.textContent !== 'ENTER VR' && ! vrButton.disabled ) ) return;
	vrButton.disabled = ! settled;
	vrButton.textContent = settled ? 'ENTER VR' : '読み込み中…';
	vrGateOpen = settled;

}
const vr = initVR( {
	renderer, scene, camera, rig, controls, pointAt,
	groundTargets: () => raycastTargets( [ terrain, ...buildings ] ),
	adjustWater,
	cities: cities.map( c => ( { code: c.code, pref: c.pref, city: c.city } ) ),
	currentCity: () => city.code,
	selectCity: switchCity,
	pins,
	minimap,
	bounds: () => bounds,
	toLocal,
	toLatLon,
	startPose: vrStartPose,
	tileStatus: () => [ [ useGoogle ? 'Google' : '地形', terrain ] as const, ...buildings.map( t => [ '建物', t ] as const ) ]
		.map( ( [ name, t ] ) => {

			const s = tileStats( t );
			return `${ name }タイル 表示 ${ s.visible }　読込待ち ${ s.queued }　通信中 ${ s.downloading }　展開中 ${ s.parsing }　失敗 ${ s.failed }`;

		} ),
} );

// Counters the renderer keeps (not in its type declarations).
function tileStats( tiles: TilesRenderer ) {

	return ( tiles as unknown as { stats: Record<'visible' | 'queued' | 'downloading' | 'parsing' | 'failed', number> } ).stats;

}

// A city picked in VR is framed for the map view on the way out.
renderer.xr.addEventListener( 'sessionend', () => {

	if ( framedCity !== city.code ) frameCity();

} );

// Google's terms: say which part of the scene is Google Maps data, and show the data providers of
// the tiles in view in full.
let sinceAttribution = Infinity;
function updateGoogleAttribution( dt: number ) {

	sinceAttribution += dt;
	if ( sinceAttribution < 1 ) return;
	sinceAttribution = 0;
	const text = terrain.getAttributions().filter( a => a.type === 'string' ).map( a => a.value ).join( ' ' );
	$( '#google-attribution' ).textContent = `地面・建物の 3D: Google Maps${ text ? `（${ text }）` : '' } ／ `;

}

// The headset's view at the VR start point (config VR_START), roughly: eye height, the headset's
// field of view and resolution.
const XR_RESOLUTION = 1800; // px per eye, for picking the tiles' detail in VR
const EYE_HEIGHT = 1.6; // m
const startEye = new THREE.PerspectiveCamera( 100, 1, 0.1, 2e6 );
function placeStartEye() {

	const pose = vrStartPose();
	if ( ! pose ) return false;
	startEye.position.copy( pose.position ).setY( pose.position.y + EYE_HEIGHT );
	startEye.rotation.set( 0, pose.yaw, 0 );
	startEye.updateMatrixWorld();
	return true;

}

// Keep the point the map view looks at within the bounds (dragging could slide it off to where
// nothing is shown); the camera moves with it, so the view keeps its angle.
const outside = new THREE.Vector3();
function keepInBounds() {

	outside.copy( controls.target ).clamp( bounds.min, bounds.max ).sub( controls.target );
	if ( outside.lengthSq() === 0 ) return;
	controls.target.add( outside );
	camera.position.add( outside );

}

// Keep the map view's camera above the ground (orbiting low, it could dip into a hill). The
// ground under it is looked up a few times a second, the raycast being heavy.
const CAMERA_CLEARANCE = 2; // m
const groundRay = new THREE.Raycaster( new THREE.Vector3(), new THREE.Vector3( 0, - 1, 0 ) );
groundRay.firstHitOnly = true;
let groundUnderCamera = - Infinity;
let sinceGroundCheck = Infinity;
function keepAboveGround( dt: number ) {

	sinceGroundCheck += dt;
	if ( sinceGroundCheck >= 0.2 ) {

		sinceGroundCheck = 0;
		groundRay.ray.origin.set( camera.position.x, 5000, camera.position.z );
		groundUnderCamera = groundRay.intersectObjects( raycastTargets( [ terrain, ...buildings ] ), true )[ 0 ]?.point.y ?? - Infinity;

	}

	camera.position.y = Math.max( camera.position.y, groundUnderCamera + CAMERA_CLEARANCE );

}

// ─── loop ───────────────────────────────────────────────────────────────────
const WATER_RISE_TIME = 1.5; // s, ground → full depth
const clock = new THREE.Clock();
const eye = new THREE.Vector3();
const eyeRotation = new THREE.Quaternion();
// On a touch screen the tiles are picked as if for a screen this much smaller: a phone's pixels
// are fine enough that coarser tiles look much the same, and they take less memory and time.
const TOUCH_DETAIL = 0.65;
const drawingBuffer = new THREE.Vector2();
const loading = createLoadingIndicator( camera );
renderer.setAnimationLoop( () => {

	const dt = Math.min( clock.getDelta(), 0.1 );
	const step = dt / WATER_RISE_TIME;
	waterLevel.value = THREE.MathUtils.clamp( waterTarget, waterLevel.value - step, waterLevel.value + step );

	const xr = renderer.xr;
	const move = moveInput( dt );
	if ( xr.isPresenting ) vr.update( dt );
	else if ( street.active ) street.update( dt, move );
	else {

		updateFly( dt );
		panView( move, dt );
		controls.update();
		keepInBounds();
		keepAboveGround( dt );

	}

	scene.updateMatrixWorld();
	const active = xr.isPresenting ? xr.getCamera() : camera;
	if ( xr.isPresenting ) {

		// The XR camera holds the head pose relative to the rig and has no parent, so
		// updateMatrixWorld() would leave it near the origin and the tiles would be culled and
		// refined for the wrong place. Put it in the world through the rig.
		active.matrixWorld.multiplyMatrices( rig.matrixWorld, active.matrix );
		active.matrixWorldInverse.copy( active.matrixWorld ).invert();

	} else {

		active.updateMatrixWorld();

	}

	// Outside VR, also look from the VR start point, so its street-level tiles are loaded (and the
	// VR button held back) before the user steps in, instead of popping in after. Not on a touch
	// screen, which has no VR: there it would double what loads, and the street view loads its
	// tiles as it goes.
	const eyes = xr.isPresenting ? [ active ] : ! touchUI && placeStartEye() ? [ camera, startEye ] : [ camera ];
	if ( touchUI && ! xr.isPresenting ) renderer.getDrawingBufferSize( drawingBuffer );
	let busy = false;
	for ( const t of allTiles() ) {

		if ( t.cameras.length !== eyes.length || ! eyes.every( c => t.hasCamera( c ) ) ) {

			t.cameras.slice().forEach( c => t.deleteCamera( c ) );
			eyes.forEach( c => t.setCamera( c ) );

		}

		if ( xr.isPresenting ) t.setResolution( active, XR_RESOLUTION, XR_RESOLUTION );
		else if ( touchUI ) t.setResolution( camera, drawingBuffer.x * TOUCH_DETAIL, drawingBuffer.y * TOUCH_DETAIL );
		else t.setResolutionFromRenderer( camera, renderer );
		if ( eyes.includes( startEye ) ) t.setResolution( startEye, XR_RESOLUTION, XR_RESOLUTION );
		t.update();
		busy ||= t.loadProgress < 1;

	}

	// In VR the pins face the head, with their labels in the scene; on a flat screen the stems lie
	// flat in it, so they don't fan out, and the labels are HTML, placed on the stems after.
	const flat = ! xr.isPresenting;
	pins.update( camera.getWorldPosition( eye ), flat ? camera.getWorldQuaternion( eyeRotation ) : null, ! flat );
	pinLayer.hidden = ! flat;
	if ( flat ) pins.showStems( screenPins.update( camera, pins.heads() ) );
	if ( useGoogle ) updateGoogleAttribution( dt );
	loading.update( dt, busy, xr.isPresenting );
	gateVRButton( loading.settled );
	gateStreetButton( loading.settled );

	renderer.render( scene, camera );

} );
