import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { VRButton } from 'three/addons/webxr/VRButton.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { TilesRenderer, WGS84_ELLIPSOID } from '3d-tiles-renderer/three';
import { GLTFExtensionsPlugin } from '3d-tiles-renderer/three/plugins';
import catalog from './data/cities.json';
import { depthColor, featureLabel, parseDepthLabel } from './flood';
import { BASE_MAPS, createTerrain, type BaseMapKey } from './terrain';
import { initVR } from './vr';
import './style.css';

type City = ( typeof catalog.cities )[ number ];

const DEG = Math.PI / 180;
const params = new URLSearchParams( location.search );
// 鎌倉市: hilly with valleys, close to the Shinagawa PoC area's terrain.
const city: City = catalog.cities.find( c => c.code === params.get( 'city' ) ) ?? catalog.cities.find( c => c.code === '14204' )!;

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
{

	const enu = new THREE.Matrix4();
	WGS84_ELLIPSOID.getEastNorthUpFrame( city.lat * DEG, city.lon * DEG, city.groundHeight, enu );
	world.matrix.makeRotationX( - Math.PI / 2 ).multiply( enu.invert() );

}

scene.add( world );

const camera = new THREE.PerspectiveCamera( 55, window.innerWidth / window.innerHeight, 0.1, 2e6 );
const rig = new THREE.Group();
rig.add( camera );
scene.add( rig );

// Start looking down over the flood area from the south.
const extent = Math.max(
	( city.bounds[ 2 ] - city.bounds[ 0 ] ) * 111e3 * Math.cos( city.lat * DEG ),
	( city.bounds[ 3 ] - city.bounds[ 1 ] ) * 111e3,
);
camera.position.set( 0, extent * 0.45, extent * 0.55 );

const controls = new OrbitControls( camera, renderer.domElement );
controls.target.set( 0, 0, 0 );
controls.enableDamping = true;
controls.maxPolarAngle = Math.PI * 0.49;
controls.minDistance = 20;
controls.maxDistance = extent * 4;
controls.screenSpacePanning = false;
controls.update();

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

const buildings = city.buildings.map( b => {

	const tiles = plateauTiles( b.url );
	tiles.errorTarget = 8;
	return tiles;

} );

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

const floods = city.floods.map( ( f, i ) => {

	const tiles = plateauTiles( f.url );
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
		const featureLabels: string[] = [];
		const count = Math.max( rankOrg.length, rank.length );
		for ( let id = 0; id < count; id ++ ) {

			const label = featureLabel( rankOrg[ id ], rank[ id ] );
			const range = parseDepthLabel( label );
			labels.set( label, range );
			featureLabels.push( label );
			colors.push( depthColor( range ) );

		}

		model.traverse( obj => {

			const mesh = obj as THREE.Mesh;
			if ( ! mesh.isMesh ) return;
			const geom = mesh.geometry;
			const ids = geom.getAttribute( '_batchid' );
			const n = geom.getAttribute( 'position' ).count;
			const buf = new Float32Array( n * 3 );
			for ( let v = 0; v < n; v ++ ) {

				const c = colors[ ids ? ids.getX( v ) : 0 ] ?? depthColor( null );
				buf.set( [ c.r, c.g, c.b ], v * 3 );

			}

			geom.setAttribute( 'color', new THREE.BufferAttribute( buf, 3 ) );
			mesh.material = floodMaterial;
			mesh.renderOrder = 10;
			mesh.userData.featureLabels = featureLabels;

		} );

		renderLegend();

	} );

	return tiles;

} );

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
const $ = <T extends HTMLElement>( sel: string ) => document.querySelector( sel ) as T;

function syncURL() {

	const q = new URLSearchParams( { city: city.code, base: baseMap } );
	history.replaceState( null, '', `?${ q }` );

}

function buildUI() {

	const citySel = $<HTMLSelectElement>( '#city' );
	for ( const c of catalog.cities ) {

		citySel.add( new Option( `${ c.pref } ${ c.city }`, c.code, false, c.code === city.code ) );

	}

	citySel.addEventListener( 'change', () => {

		location.search = new URLSearchParams( { city: citySel.value, base: baseMap } ).toString();

	} );

	const baseSel = $<HTMLSelectElement>( '#base' );
	for ( const [ key, b ] of Object.entries( BASE_MAPS ) ) baseSel.add( new Option( b.label, key, false, key === baseMap ) );
	baseSel.addEventListener( 'change', () => setBaseMap( baseSel.value as BaseMapKey ) );

	const list = $( '#floods' );
	city.floods.forEach( ( f, i ) => {

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
		list.append( row );

	} );

	const bldg = $<HTMLInputElement>( '#show-buildings' );
	bldg.addEventListener( 'change', () => buildings.forEach( t => ( t.group.visible = bldg.checked ) ) );

	const opacity = $<HTMLInputElement>( '#opacity' );
	opacity.addEventListener( 'input', () => ( floodMaterial.opacity = Number( opacity.value ) ) );

	$( '#panel-toggle' ).addEventListener( 'click', () => document.body.classList.toggle( 'panel-closed' ) );
	if ( window.innerWidth < 640 ) document.body.classList.add( 'panel-closed' );

	$( '#title' ).textContent = `${ city.pref } ${ city.city }`;
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

// Tap / click a flood polygon to read its depth.
const raycaster = new THREE.Raycaster();
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
	const targets = floods.filter( t => t.group.visible ).map( t => t.group );
	const hit = raycaster.intersectObjects( targets, true )[ 0 ];
	const info = $( '#info' );
	if ( ! hit || ! hit.face ) {

		info.hidden = true;
		return;

	}

	const mesh = hit.object as THREE.Mesh;
	const ids = mesh.geometry.getAttribute( '_batchid' );
	const label = mesh.userData.featureLabels?.[ ids ? ids.getX( hit.face.a ) : 0 ] ?? '不明';
	info.textContent = `想定浸水深: ${ label }`;
	info.hidden = false;

} );

window.addEventListener( 'resize', () => {

	camera.aspect = window.innerWidth / window.innerHeight;
	camera.updateProjectionMatrix();
	renderer.setSize( window.innerWidth, window.innerHeight );

} );

buildUI();

// Handles for poking at the scene from the dev-tools console.
if ( import.meta.env.DEV ) Object.assign( window, { app: { scene, world, camera, controls, terrain, buildings, floods, legend } } );

// ─── VR ─────────────────────────────────────────────────────────────────────
document.body.appendChild( VRButton.createButton( renderer ) );
const vr = initVR( { renderer, camera, rig, controls, groundTargets: () => [ terrain.group, ...buildings.map( t => t.group ) ] } );

// ─── loop ───────────────────────────────────────────────────────────────────
const clock = new THREE.Clock();
renderer.setAnimationLoop( () => {

	const dt = Math.min( clock.getDelta(), 0.1 );
	const xr = renderer.xr;
	if ( xr.isPresenting ) vr.update( dt );
	else controls.update();

	scene.updateMatrixWorld();
	const active = xr.isPresenting ? xr.getCamera() : camera;
	active.updateMatrixWorld();
	for ( const t of allTiles() ) {

		if ( ! t.hasCamera( active ) ) {

			t.cameras.slice().forEach( c => t.deleteCamera( c ) );
			t.setCamera( active );

		}

		if ( xr.isPresenting ) t.setResolution( active, 1800, 1800 );
		else t.setResolutionFromRenderer( camera, renderer );
		t.update();

	}

	renderer.render( scene, camera );

} );
