import * as THREE from 'three';
import { SHELTER_COLOR, STORY_COLOR, type Place } from './places';

const TILE_URL = 'https://cyberjapandata.gsi.go.jp/xyz/pale/{z}/{x}/{y}.png';
const TILE = 256;
const ZOOM = 16; // about 2 m per pixel at Kamakura
export const MINIMAP_WIDTH = 0.16; // m
const WINDOW_METERS = 800; // across the map, centered on the user
const PICK_RADIUS = 22; // px on the source map: how near a spot the ray must point
const LEGEND_HEIGHT = 0.022; // m

// Web Mercator pixel coordinates at zoom z.
function mercator( lat: number, lon: number, z: number ) {

	const n = TILE * 2 ** z;
	const s = Math.sin( lat * Math.PI / 180 );
	return { x: ( lon + 180 ) / 360 * n, y: ( 0.5 - Math.log( ( 1 + s ) / ( 1 - s ) ) / ( 4 * Math.PI ) ) * n };

}

// A north-up map for the left hand in VR, showing about WINDOW_METERS around the user, with an
// arrow for where they are and which way they face. Landmarks and story spots are drawn large:
// pointing at one with the right hand and pulling the trigger takes the user there.
// The whole area is drawn once per city into one texture; following the user only shifts which
// part of it the plane shows (texture offset), so nothing is uploaded per frame.
export function createMinimap() {

	const canvas = document.createElement( 'canvas' );
	const ctx = canvas.getContext( '2d' )!;
	const texture = new THREE.CanvasTexture( canvas );
	texture.colorSpace = THREE.SRGBColorSpace;
	texture.anisotropy = 4;
	texture.generateMipmaps = false;
	texture.minFilter = THREE.LinearFilter;
	const mesh = new THREE.Mesh(
		new THREE.PlaneGeometry( 1, 1 ),
		new THREE.MeshBasicMaterial( { map: texture, depthTest: false, transparent: true } ),
	);
	// Over everything in the scene (pins and cards are 1001–1002): it is in the user's hand.
	mesh.renderOrder = 1100;
	mesh.scale.set( MINIMAP_WIDTH, MINIMAP_WIDTH, 1 );
	const object = new THREE.Group();
	object.add( mesh );

	// The arrow and the ring around a pointed-at spot sit over the plane, unscaled, so they keep
	// their shape.
	const arrowShape = new THREE.Shape().moveTo( 0, 0.5 ).lineTo( 0.4, - 0.5 ).lineTo( 0, - 0.25 ).lineTo( - 0.4, - 0.5 ).closePath();
	const arrow = new THREE.Mesh(
		new THREE.ShapeGeometry( arrowShape ),
		// Transparent like the map, so it is drawn after it (renderOrder only orders within a pass).
		new THREE.MeshBasicMaterial( { color: '#e11d48', depthTest: false, transparent: true } ),
	);
	arrow.renderOrder = 1102;
	arrow.scale.setScalar( 0.018 ); // m
	arrow.position.z = 0.001;
	const ring = new THREE.Mesh(
		new THREE.RingGeometry( 0.0075, 0.0105, 32 ),
		new THREE.MeshBasicMaterial( { color: '#f59e0b', depthTest: false, transparent: true } ),
	);
	ring.renderOrder = 1101;
	ring.position.z = 0.001;
	ring.visible = false;
	object.add( arrow, ring );

	const legend = new THREE.Mesh(
		new THREE.PlaneGeometry( 1, 1 ),
		new THREE.MeshBasicMaterial( { map: legendTexture(), depthTest: false, transparent: true } ),
	);
	legend.renderOrder = 1100;
	legend.scale.set( MINIMAP_WIDTH, LEGEND_HEIGHT, 1 );
	legend.position.y = - ( MINIMAP_WIDTH + LEGEND_HEIGHT ) / 2 - 0.002;
	object.add( legend );

	let view = { x0: 0, y0: 0, width: 1, height: 1, window: 1 };
	let targets: { place: Place, x: number, y: number }[] = [];
	let center = { x: 0, y: 0 }; // px on the source map at the plane's middle
	let ringPlace: Place | null = null; // the spot being pointed at
	let generation = 0;

	// Draw the map of `bounds` ([west, south, east, north]) with the places on it.
	async function setCity( bounds: number[], places: Place[] ) {

		const [ west, south, east, north ] = bounds;
		const nw = mercator( north, west, ZOOM ), se = mercator( south, east, ZOOM );
		canvas.width = Math.ceil( se.x - nw.x );
		canvas.height = Math.ceil( se.y - nw.y );
		// Meters per pixel at this latitude.
		const metersPerPixel = 40075016.686 * Math.cos( ( north + south ) / 2 * Math.PI / 180 ) / ( TILE * 2 ** ZOOM );
		view = { x0: nw.x, y0: nw.y, width: canvas.width, height: canvas.height, window: WINDOW_METERS / metersPerPixel };
		texture.repeat.set( view.window / view.width, view.window / view.height );
		targets = places.filter( p => p.kind !== 'shelter' ).map( place => ( { place, ...toCanvas( place.lat, place.lon ) } ) );

		const mine = ++ generation;
		ctx.fillStyle = '#e8ebe4';
		ctx.fillRect( 0, 0, canvas.width, canvas.height );
		texture.needsUpdate = true;

		const tiles: Promise<void>[] = [];
		for ( let ty = Math.floor( nw.y / TILE ); ty * TILE < se.y; ty ++ ) {

			for ( let tx = Math.floor( nw.x / TILE ); tx * TILE < se.x; tx ++ ) {

				const url = TILE_URL.replace( '{z}', `${ ZOOM }` ).replace( '{x}', `${ tx }` ).replace( '{y}', `${ ty }` );
				tiles.push( fetch( url )
					.then( r => r.blob() )
					.then( b => createImageBitmap( b ) )
					.then( img => {

						if ( mine === generation ) ctx.drawImage( img, tx * TILE - nw.x, ty * TILE - nw.y );

					} )
					.catch( () => {} ) );

			}

		}

		await Promise.all( tiles );
		if ( mine !== generation ) return;

		ctx.textBaseline = 'middle';
		ctx.lineJoin = 'round';
		// Shelters small and under the rest; landmarks, then story spots, large and named.
		const order = { shelter: 0, landmark: 1, story: 2 };
		for ( const p of [ ...places ].sort( ( a, b ) => order[ a.kind ] - order[ b.kind ] ) ) {

			const { x, y } = toCanvas( p.lat, p.lon );
			const r = p.kind === 'shelter' ? 6 : p.kind === 'landmark' ? 9 : 12;
			ctx.beginPath();
			ctx.arc( x, y, r, 0, Math.PI * 2 );
			ctx.fillStyle = p.kind === 'shelter' ? SHELTER_COLOR : p.kind === 'story' ? STORY_COLOR : '#1d2733';
			ctx.fill();
			ctx.strokeStyle = '#ffffff';
			ctx.lineWidth = 3;
			ctx.stroke();
			if ( p.kind === 'shelter' ) continue;
			ctx.font = `bold ${ p.kind === 'story' ? 22 : 19 }px system-ui, sans-serif`;
			ctx.lineWidth = 5;
			ctx.strokeText( p.name, x + r + 6, y );
			ctx.fillStyle = p.kind === 'story' ? STORY_COLOR : '#1d2733';
			ctx.fillText( p.name, x + r + 6, y );

		}

		texture.needsUpdate = true;

	}

	function toCanvas( lat: number, lon: number ) {

		const p = mercator( lat, lon, ZOOM );
		return { x: p.x - view.x0, y: p.y - view.y0 };

	}

	// Center the map on where the user is, and turn the arrow. `heading` is clockwise from north,
	// in radians. Near the edge of the area the map stops and the arrow moves off center.
	function setPosition( lat: number, lon: number, heading: number ) {

		const me = toCanvas( lat, lon );
		const half = view.window / 2;
		center = {
			x: THREE.MathUtils.clamp( me.x, half, Math.max( half, view.width - half ) ),
			y: THREE.MathUtils.clamp( me.y, half, Math.max( half, view.height - half ) ),
		};
		texture.offset.set( ( center.x - half ) / view.width, 1 - ( center.y + half ) / view.height );
		toPlane( me, arrow.position );
		arrow.rotation.z = - heading;
		const hovered = targets.find( t => t.place === ringPlace );
		if ( hovered ) toPlane( hovered, ring.position );

	}

	// Source-map pixels → position on the plane (meters, in `object`), clamped to the plane.
	function toPlane( p: { x: number, y: number }, out: THREE.Vector3 ) {

		const u = THREE.MathUtils.clamp( ( p.x - center.x ) / view.window, - 0.5, 0.5 );
		const v = THREE.MathUtils.clamp( ( p.y - center.y ) / view.window, - 0.5, 0.5 );
		out.x = u * MINIMAP_WIDTH;
		out.y = - v * MINIMAP_WIDTH;

	}

	// The landmark or story spot a ray points at on the map, if any.
	const raycaster = new THREE.Raycaster();
	const hits: THREE.Intersection[] = [];
	function pick( ray: THREE.Ray ): { place: Place, distance: number } | null {

		if ( ! object.visible ) return null;
		raycaster.ray.copy( ray );
		hits.length = 0;
		mesh.raycast( raycaster, hits );
		const hit = hits[ 0 ];
		if ( ! hit?.uv ) return null;
		const x = center.x + ( hit.uv.x - 0.5 ) * view.window;
		const y = center.y - ( hit.uv.y - 0.5 ) * view.window;
		let best: typeof targets[ number ] | null = null, bestD = PICK_RADIUS;
		for ( const t of targets ) {

			const d = Math.hypot( t.x - x, t.y - y );
			if ( d < bestD ) {

				best = t;
				bestD = d;

			}

		}

		return best ? { place: best.place, distance: hit.distance } : null;

	}

	// Ring the spot being pointed at (or none).
	function hover( place: Place | null ) {

		ringPlace = place;
		ring.visible = !! place;
		const t = targets.find( t => t.place === place );
		if ( t ) toPlane( t, ring.position );

	}

	return {
		object,
		setCity,
		setPosition,
		pick,
		hover,
		get height() { return MINIMAP_WIDTH + LEGEND_HEIGHT + 0.002; },
		get bottom() { return MINIMAP_WIDTH / 2 + LEGEND_HEIGHT + 0.002; }, // below `object`'s origin
	};

}

// The strip under the map: what the dots are, how to jump to one, and the map's source.
function legendTexture() {

	const canvas = document.createElement( 'canvas' );
	canvas.width = 1024;
	canvas.height = Math.round( 1024 * LEGEND_HEIGHT / MINIMAP_WIDTH );
	const ctx = canvas.getContext( '2d' )!;
	ctx.fillStyle = 'rgba(20, 26, 36, 0.88)';
	ctx.beginPath();
	ctx.roundRect( 0, 0, canvas.width, canvas.height, 18 );
	ctx.fill();
	ctx.textBaseline = 'middle';
	let x = 22;
	const y = canvas.height / 2;
	for ( const [ color, label ] of [ [ STORY_COLOR, '解説' ], [ '#1d2733', '目印' ], [ SHELTER_COLOR, '避難所' ] ] ) {

		ctx.beginPath();
		ctx.arc( x + 11, y, 11, 0, Math.PI * 2 );
		ctx.fillStyle = color;
		ctx.fill();
		ctx.strokeStyle = '#ffffff';
		ctx.lineWidth = 3;
		ctx.stroke();
		ctx.font = 'bold 28px system-ui, sans-serif';
		ctx.fillStyle = '#ffffff';
		ctx.fillText( label, x + 30, y );
		x += 30 + ctx.measureText( label ).width + 26;

	}

	ctx.font = '24px system-ui, sans-serif';
	ctx.fillStyle = '#fcd34d';
	ctx.fillText( '解説・目印を指して右トリガーで移動', x + 6, y );
	ctx.textAlign = 'right';
	ctx.fillStyle = '#9fb3c8';
	ctx.font = '20px system-ui, sans-serif';
	ctx.fillText( '地理院タイル', canvas.width - 18, y );
	const texture = new THREE.CanvasTexture( canvas );
	texture.colorSpace = THREE.SRGBColorSpace;
	return texture;

}
