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
import { createPins, placesFor } from './places';
import { createMinimap } from './vr-minimap';
import './style.css';

type City = ( typeof catalog.cities )[ number ];

const DEG = Math.PI / 180;
const params = new URLSearchParams( location.search );
const $ = <T extends HTMLElement>( sel: string ) => document.querySelector( sel ) as T;
// With a Google Map Tiles API key (in .env, never committed), Google's photorealistic 3D tiles
// stand in for the GSI terrain and the PLATEAU buildings; without one, those are used.
const GOOGLE_KEY: string | undefined = import.meta.env.VITE_GOOGLE_MAPS_API_KEY || undefined;

const cities = ONLY_CITY ? catalog.cities.filter( c => c.code === ONLY_CITY ) : catalog.cities;
// 鎌倉市: hilly with valleys, close to the Shinagawa PoC area's terrain.
let city: City = cities.find( c => c.code === params.get( 'city' ) ) ?? cities.find( c => c.code === '14204' ) ?? cities[ 0 ];

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

// Where the ground and the flood tiles load: the VR bounds and some more, so the ground runs out a
// little past where the user can go. In ECEF, the tiles' own frame.
const TERRAIN_MARGIN = 300; // m beyond the VR bounds
function terrainArea() {

	const box = bounds.clone().expandByVector( new THREE.Vector3( TERRAIN_MARGIN, 0, TERRAIN_MARGIN ) );
	box.min.y = - 500;
	return new OBB( box, world.matrix.clone().invert() );

}

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

let baseMap: BaseMapKey = ( params.get( 'base' ) as BaseMapKey ) in BASE_MAPS ? params.get( 'base' ) as BaseMapKey : 'photo';
// The ground: GSI terrain, or Google's 3D tiles (ground and buildings in one).
function createGround() {

	return GOOGLE_KEY ? createGoogleTiles( GOOGLE_KEY, terrainArea(), dracoLoader ) : createTerrain( city.geoidHeight, baseMap, terrainArea() );

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

	waterTarget = on ? 1 : 0;
	$<HTMLInputElement>( '#raise-water' ).checked = on;

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

function loadCityTiles() {

	const showBuildings = $<HTMLInputElement>( '#show-buildings' ).checked;
	// Google's tiles have the buildings already.
	buildings = GOOGLE_KEY ? [] : city.buildings.map( b => {

		const tiles = plateauTiles( b.url );
		tiles.errorTarget = 8;
		tiles.group.visible = showBuildings;
		return tiles;

	} );
	floods = city.floods.map( floodTiles );

}

loadCityTiles();

// Landmarks and shelters, as pins in the scene and dots on the VR hand map.
const pins = createPins();
scene.add( pins.group );
const minimap = createMinimap();
function loadPlaces() {

	const places = placesFor( city.code ).filter( p => inArea( p.lat, p.lon ) );
	pins.setPlaces( city.city, places, toLocal );
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

		frameCity();

	}

}

function addTiles( tiles: TilesRenderer ) {

	tiles.setCamera( camera );
	tiles.setResolutionFromRenderer( camera, renderer );
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

function syncURL() {

	const q = new URLSearchParams( { city: city.code, base: baseMap } );
	history.replaceState( null, '', `?${ q }` );

}

function buildUI() {

	const citySel = $<HTMLSelectElement>( '#city' );
	citySel.closest( 'label' )!.hidden = cities.length < 2;
	for ( const c of cities ) {

		citySel.add( new Option( `${ c.pref } ${ c.city }`, c.code, false, c.code === city.code ) );

	}

	citySel.addEventListener( 'change', () => switchCity( citySel.value ) );

	const baseSel = $<HTMLSelectElement>( '#base' );
	baseSel.closest( 'label' )!.hidden = !! GOOGLE_KEY;
	$( '#show-buildings' ).closest( 'label' )!.hidden = !! GOOGLE_KEY;
	$( '#google-attribution' ).hidden = ! GOOGLE_KEY;
	for ( const [ key, b ] of Object.entries( BASE_MAPS ) ) baseSel.add( new Option( b.label, key, false, key === baseMap ) );
	baseSel.addEventListener( 'change', () => setBaseMap( baseSel.value as BaseMapKey ) );

	const bldg = $<HTMLInputElement>( '#show-buildings' );
	bldg.addEventListener( 'change', () => buildings.forEach( t => ( t.group.visible = bldg.checked ) ) );

	const opacity = $<HTMLInputElement>( '#opacity' );
	opacity.addEventListener( 'input', () => ( floodMaterial.opacity = Number( opacity.value ) ) );

	const raise = $<HTMLInputElement>( '#raise-water' );
	raise.addEventListener( 'change', () => setWaterRaised( raise.checked ) );

	$( '#panel-toggle' ).addEventListener( 'click', () => document.body.classList.toggle( 'panel-closed' ) );
	if ( window.innerWidth < 640 ) document.body.classList.add( 'panel-closed' );

	renderCityUI();

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
	$( '#legend' ).hidden = items.length === 0;

}

// What to raycast for a set of tilesets. For PLATEAU tiles, the tiles currently in the scene: the
// group's own raycast walks the whole cached tile tree on every call. The terrain must go through its
// group, though: its meshes are flat and displaced on the GPU, and only the terrain plugin's raycast
// (reached via the group) applies the elevation.
function raycastTargets( sets: TilesRenderer[] ) {

	return sets.filter( t => t.group.visible ).flatMap( t => ( t === terrain && ! GOOGLE_KEY ? [ t.group ] : t.group.children ) );

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

// Pressing on an open card's top strip drags the card instead of the view.
let downAt = { x: 0, y: 0 };
renderer.domElement.addEventListener( 'pointerdown', e => {

	downAt = { x: e.clientX, y: e.clientY };
	if ( pins.startDrag( rayAt( e ) ) ) controls.enabled = false;

} );

// Show a grabbing hand while the view is being dragged (not on a plain click).
// OrbitControls writes an inline cursor style, so set it inline too rather than via CSS.
const setCursor = ( c: string ) => ( renderer.domElement.style.cursor = c );
renderer.domElement.addEventListener( 'pointermove', e => {

	if ( pins.dragging ) pins.dragTo( rayAt( e ) );
	if ( e.buttons && Math.hypot( e.clientX - downAt.x, e.clientY - downAt.y ) > 6 ) setCursor( 'grabbing' );

} );
function endCardDrag() {

	if ( ! pins.dragging ) return false;
	pins.endDrag();
	pins.hoverPart( null );
	controls.enabled = true;
	return true;

}

renderer.domElement.addEventListener( 'pointercancel', () => {

	setCursor( 'auto' );
	endCardDrag();

} );

renderer.domElement.addEventListener( 'pointerup', e => {

	setCursor( 'auto' );
	if ( endCardDrag() ) return;
	if ( Math.hypot( e.clientX - downAt.x, e.clientY - downAt.y ) > 6 ) return;
	rayAt( e );
	const info = $( '#info' );
	// The open card is drawn over everything, so a click on it is for the card alone.
	const onCard = pins.pickCard( raycaster.ray );
	if ( onCard ) {

		if ( onCard.part === 'close' ) pins.close();
		return;

	}

	const pin = pins.pick( raycaster.ray );
	if ( pin ) {

		pins.toggle( pin.place );
		info.hidden = true;
		return;

	}

	const { flood } = pointAt( raycaster );
	info.hidden = ! flood;
	if ( flood ) info.textContent = `想定浸水深: ${ flood.label }`;

} );

window.addEventListener( 'resize', () => {

	camera.aspect = window.innerWidth / window.innerHeight;
	camera.updateProjectionMatrix();
	renderer.setSize( window.innerWidth, window.innerHeight );

} );

buildUI();

// Handles for poking at the scene from the dev-tools console.
// Getters, since switching cities replaces the tilesets.
if ( import.meta.env.DEV ) {

	Object.assign( window, { app: {
		renderer, scene, world, camera, controls, legend, pins, minimap, toLocal, toLatLon,
		get vr() { return vr; },
		get city() { return city; },
		get terrain() { return terrain; },
		get buildings() { return buildings; },
		get floods() { return floods; },
	} } );

}

// ─── VR ─────────────────────────────────────────────────────────────────────
const vrButton = VRButton.createButton( renderer ) as HTMLButtonElement;
document.body.appendChild( vrButton );

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
	toggleWater: () => setWaterRaised( waterTarget === 0 ),
	cities: cities.map( c => ( { code: c.code, pref: c.pref, city: c.city } ) ),
	currentCity: () => city.code,
	selectCity: switchCity,
	pins,
	minimap,
	bounds: () => bounds,
	toLatLon,
	startPose: vrStartPose,
	tileStatus: () => [ [ GOOGLE_KEY ? 'Google' : '地形', terrain ] as const, ...buildings.map( t => [ '建物', t ] as const ) ]
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
	$( '#google-attribution' ).textContent = `／ 地面・建物の 3D: Google Maps${ text ? `（${ text }）` : '' }`;

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
const loading = createLoadingIndicator( camera );
renderer.setAnimationLoop( () => {

	const dt = Math.min( clock.getDelta(), 0.1 );
	const step = dt / WATER_RISE_TIME;
	waterLevel.value = THREE.MathUtils.clamp( waterTarget, waterLevel.value - step, waterLevel.value + step );

	const xr = renderer.xr;
	if ( xr.isPresenting ) vr.update( dt );
	else {

		// As in VR, an open card holds the view in place: it can turn around, but not pan or zoom
		// away until the card is closed.
		controls.enablePan = controls.enableZoom = ! pins.isOpen;
		controls.update();
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
	// VR button held back) before the user steps in, instead of popping in after.
	const eyes = xr.isPresenting ? [ active ] : placeStartEye() ? [ camera, startEye ] : [ camera ];
	let busy = false;
	for ( const t of allTiles() ) {

		if ( t.cameras.length !== eyes.length || ! eyes.every( c => t.hasCamera( c ) ) ) {

			t.cameras.slice().forEach( c => t.deleteCamera( c ) );
			eyes.forEach( c => t.setCamera( c ) );

		}

		if ( xr.isPresenting ) t.setResolution( active, XR_RESOLUTION, XR_RESOLUTION );
		else t.setResolutionFromRenderer( camera, renderer );
		if ( eyes.includes( startEye ) ) t.setResolution( startEye, XR_RESOLUTION, XR_RESOLUTION );
		t.update();
		busy ||= t.loadProgress < 1;

	}

	pins.update( camera.getWorldPosition( eye ) );
	if ( GOOGLE_KEY ) updateGoogleAttribution( dt );
	loading.update( dt, busy, xr.isPresenting );
	gateVRButton( loading.settled );

	renderer.render( scene, camera );

} );
