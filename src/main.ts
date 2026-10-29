import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { VRButton } from 'three/addons/webxr/VRButton.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { TilesRenderer, WGS84_ELLIPSOID } from '3d-tiles-renderer/three';
import { GLTFExtensionsPlugin } from '3d-tiles-renderer/three/plugins';
import { acceleratedRaycast, computeBoundsTree } from 'three-mesh-bvh';
import catalog from './data/cities.json';
import { depthColor, featureLabel, parseDepthLabel, surfaceHeight } from './flood';
import { BASE_MAPS, createTerrain, type BaseMapKey } from './terrain';
import { initVR } from './vr';
import { createLoadingIndicator } from './loading';
import './style.css';

type City = ( typeof catalog.cities )[ number ];

const DEG = Math.PI / 180;
const params = new URLSearchParams( location.search );
const $ = <T extends HTMLElement>( sel: string ) => document.querySelector( sel ) as T;
// 鎌倉市: hilly with valleys, close to the Shinagawa PoC area's terrain.
let city: City = catalog.cities.find( c => c.code === params.get( 'city' ) ) ?? catalog.cities.find( c => c.code === '14204' )!;

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

const camera = new THREE.PerspectiveCamera( 55, window.innerWidth / window.innerHeight, 0.1, 2e6 );
const rig = new THREE.Group();
rig.add( camera );
scene.add( rig );

// Size of the flood area in meters.
function cityExtent() {

	return Math.max(
		( city.bounds[ 2 ] - city.bounds[ 0 ] ) * 111e3 * Math.cos( city.lat * DEG ),
		( city.bounds[ 3 ] - city.bounds[ 1 ] ) * 111e3,
	);

}

const controls = new OrbitControls( camera, renderer.domElement );
controls.enableDamping = true;
controls.maxPolarAngle = Math.PI * 0.49;
controls.minDistance = 20;
controls.screenSpacePanning = false;

// Look down over the flood area from the south.
let framedCity = '';
function frameCity() {

	const extent = cityExtent();
	camera.position.set( 0, extent * 0.45, extent * 0.55 );
	controls.target.set( 0, 0, 0 );
	controls.maxDistance = extent * 4;
	controls.update();
	framedCity = city.code;

}

frameCity();

// ─── tilesets ───────────────────────────────────────────────────────────────
let baseMap: BaseMapKey = ( params.get( 'base' ) as BaseMapKey ) in BASE_MAPS ? params.get( 'base' ) as BaseMapKey : 'photo';
let terrain = addTiles( createTerrain( city.geoidHeight, baseMap ) );

// PLATEAU b3dm tiles are Draco-compressed glTF with CESIUM_RTC centers.
const dracoLoader = new DRACOLoader().setDecoderPath( 'https://www.gstatic.com/draco/versioned/decoders/1.5.7/' );

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
	buildings = city.buildings.map( b => {

		const tiles = plateauTiles( b.url );
		tiles.errorTarget = 8;
		tiles.group.visible = showBuildings;
		return tiles;

	} );
	floods = city.floods.map( floodTiles );

}

loadCityTiles();

// Swap in another city without reloading the page, so a VR session survives it.
function switchCity( code: string ) {

	const next = catalog.cities.find( c => c.code === code );
	if ( ! next || next === city ) return;
	city = next;
	for ( const t of allTiles() ) {

		world.remove( t.group );
		t.dispose();

	}

	legend.clear();
	placeWorld();
	terrain = addTiles( createTerrain( city.geoidHeight, baseMap ) );
	loadCityTiles();
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
	terrain = addTiles( createTerrain( city.geoidHeight, key ) );
	syncURL();

}

// ─── UI ─────────────────────────────────────────────────────────────────────

function syncURL() {

	const q = new URLSearchParams( { city: city.code, base: baseMap } );
	history.replaceState( null, '', `?${ q }` );

}

function buildUI() {

	const citySel = $<HTMLSelectElement>( '#city' );
	for ( const c of catalog.cities ) {

		citySel.add( new Option( `${ c.pref } ${ c.city }`, c.code, false, c.code === city.code ) );

	}

	citySel.addEventListener( 'change', () => switchCity( citySel.value ) );

	const baseSel = $<HTMLSelectElement>( '#base' );
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

	return sets.filter( t => t.group.visible ).flatMap( t => ( t === terrain ? [ t.group ] : t.group.children ) );

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
let downAt = { x: 0, y: 0 };
renderer.domElement.addEventListener( 'pointerdown', e => ( downAt = { x: e.clientX, y: e.clientY } ) );

// Show a grabbing hand while the view is being dragged (not on a plain click).
// OrbitControls writes an inline cursor style, so set it inline too rather than via CSS.
const setCursor = ( c: string ) => ( renderer.domElement.style.cursor = c );
renderer.domElement.addEventListener( 'pointermove', e => {

	if ( e.buttons && Math.hypot( e.clientX - downAt.x, e.clientY - downAt.y ) > 6 ) setCursor( 'grabbing' );

} );
renderer.domElement.addEventListener( 'pointercancel', () => setCursor( 'auto' ) );

renderer.domElement.addEventListener( 'pointerup', e => {

	setCursor( 'auto' );
	if ( Math.hypot( e.clientX - downAt.x, e.clientY - downAt.y ) > 6 ) return;
	pointer.set( ( e.clientX / window.innerWidth ) * 2 - 1, - ( e.clientY / window.innerHeight ) * 2 + 1 );
	raycaster.setFromCamera( pointer, camera );
	const { flood } = pointAt( raycaster );
	const info = $( '#info' );
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
		renderer, scene, world, camera, controls, legend,
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

// Keep the VR button shut until the city has first loaded: entering on half-loaded tiles shows
// blank or crumbling ground. VRButton writes 'ENTER VR' once it knows VR is supported; only then
// is there anything to hold back. A slow connection can take long to load everything, so the
// button opens after VR_GATE_MAX regardless (the VR loading indicator still shows the rest).
const VR_GATE_MAX = 30; // s
let vrGateOpen = false;
function gateVRButton( settled: boolean ) {

	if ( vrGateOpen || ( vrButton.textContent !== 'ENTER VR' && ! vrButton.disabled ) ) return;
	const open = settled || performance.now() / 1000 >= VR_GATE_MAX;
	vrButton.disabled = ! open;
	vrButton.textContent = open ? 'ENTER VR' : '読み込み中…';
	vrGateOpen = open;

}
const vr = initVR( {
	renderer, scene, camera, rig, controls, pointAt,
	groundTargets: () => raycastTargets( [ terrain, ...buildings ] ),
	toggleWater: () => setWaterRaised( waterTarget === 0 ),
	cities: catalog.cities.map( c => ( { code: c.code, pref: c.pref, city: c.city } ) ),
	currentCity: () => city.code,
	selectCity: switchCity,
} );

// A city picked in VR is framed for the map view on the way out.
renderer.xr.addEventListener( 'sessionend', () => {

	if ( framedCity !== city.code ) frameCity();

} );

// ─── loop ───────────────────────────────────────────────────────────────────
const WATER_RISE_TIME = 1.5; // s, ground → full depth
const clock = new THREE.Clock();
const loading = createLoadingIndicator( camera );
renderer.setAnimationLoop( () => {

	const dt = Math.min( clock.getDelta(), 0.1 );
	const step = dt / WATER_RISE_TIME;
	waterLevel.value = THREE.MathUtils.clamp( waterTarget, waterLevel.value - step, waterLevel.value + step );

	const xr = renderer.xr;
	if ( xr.isPresenting ) vr.update( dt );
	else controls.update();

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

	let busy = false;
	for ( const t of allTiles() ) {

		if ( ! t.hasCamera( active ) ) {

			t.cameras.slice().forEach( c => t.deleteCamera( c ) );
			t.setCamera( active );

		}

		if ( xr.isPresenting ) t.setResolution( active, 1800, 1800 );
		else t.setResolutionFromRenderer( camera, renderer );
		t.update();
		busy ||= t.loadProgress < 1;

	}

	loading.update( dt, busy, xr.isPresenting );
	gateVRButton( loading.settled );

	renderer.render( scene, camera );

} );
