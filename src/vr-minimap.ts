import * as THREE from 'three';
import { SHELTER_COLOR, type Place } from './places';

const TILE_URL = 'https://cyberjapandata.gsi.go.jp/xyz/pale/{z}/{x}/{y}.png';
const TILE = 256;
const CANVAS_WIDTH = 1024;
export const MINIMAP_WIDTH = 0.16; // m

// Web Mercator pixel coordinates at zoom z.
function mercator( lat: number, lon: number, z: number ) {

	const n = TILE * 2 ** z;
	const s = Math.sin( lat * Math.PI / 180 );
	return { x: ( lon + 180 ) / 360 * n, y: ( 0.5 - Math.log( ( 1 + s ) / ( 1 - s ) ) / ( 4 * Math.PI ) ) * n };

}

// A north-up map of the city for the left hand in VR, with an arrow for where the user is and
// which way they face. The map is drawn once per city; only the arrow moves, so nothing is
// uploaded to the GPU per frame.
export function createMinimap() {

	const canvas = document.createElement( 'canvas' );
	const ctx = canvas.getContext( '2d' )!;
	const texture = new THREE.CanvasTexture( canvas );
	texture.colorSpace = THREE.SRGBColorSpace;
	texture.anisotropy = 4;
	const material = new THREE.MeshBasicMaterial( { map: texture, depthTest: false, transparent: true } );
	const mesh = new THREE.Mesh( new THREE.PlaneGeometry( 1, 1 ), material );
	mesh.renderOrder = 1000;
	// The map plane is scaled to the map's shape; the arrow sits beside it, unscaled, so it
	// doesn't skew as it turns.
	const object = new THREE.Group();
	object.add( mesh );

	const arrowShape = new THREE.Shape().moveTo( 0, 0.5 ).lineTo( 0.4, - 0.5 ).lineTo( 0, - 0.25 ).lineTo( - 0.4, - 0.5 ).closePath();
	const arrow = new THREE.Mesh(
		new THREE.ShapeGeometry( arrowShape ),
		new THREE.MeshBasicMaterial( { color: '#e11d48', depthTest: false } ),
	);
	arrow.renderOrder = 1001;
	arrow.scale.setScalar( 0.012 ); // m
	arrow.position.z = 0.001;
	object.add( arrow );

	let view = { z: 0, x0: 0, y0: 0, scale: 1, width: 1, height: 1 };
	let generation = 0;

	// Draw the map of `bounds` ([west, south, east, north]) with the places on it.
	async function setCity( bounds: number[], places: Place[] ) {

		const [ west, south, east, north ] = bounds;
		// The zoom whose tiles are about as fine as the canvas.
		const z = Math.min( 16, Math.ceil( Math.log2( CANVAS_WIDTH * 360 / ( TILE * ( east - west ) ) ) ) );
		const nw = mercator( north, west, z ), se = mercator( south, east, z );
		const scale = CANVAS_WIDTH / ( se.x - nw.x );
		canvas.width = CANVAS_WIDTH;
		canvas.height = Math.round( ( se.y - nw.y ) * scale );
		view = { z, x0: nw.x, y0: nw.y, scale, width: canvas.width, height: canvas.height };
		mesh.scale.set( MINIMAP_WIDTH, MINIMAP_WIDTH * canvas.height / canvas.width, 1 );

		const mine = ++ generation;
		ctx.fillStyle = '#e8ebe4';
		ctx.fillRect( 0, 0, canvas.width, canvas.height );
		texture.needsUpdate = true;

		const tiles: Promise<void>[] = [];
		for ( let ty = Math.floor( nw.y / TILE ); ty * TILE < se.y; ty ++ ) {

			for ( let tx = Math.floor( nw.x / TILE ); tx * TILE < se.x; tx ++ ) {

				const url = TILE_URL.replace( '{z}', `${ z }` ).replace( '{x}', `${ tx }` ).replace( '{y}', `${ ty }` );
				tiles.push( fetch( url )
					.then( r => r.blob() )
					.then( b => createImageBitmap( b ) )
					.then( img => {

						if ( mine !== generation ) return;
						const size = TILE * scale;
						ctx.drawImage( img, ( tx * TILE - nw.x ) * scale, ( ty * TILE - nw.y ) * scale, size + 0.5, size + 0.5 );

					} )
					.catch( () => {} ) );

			}

		}

		await Promise.all( tiles );
		if ( mine !== generation ) return;

		ctx.strokeStyle = '#1d2733';
		ctx.lineWidth = 4;
		ctx.strokeRect( 2, 2, canvas.width - 4, canvas.height - 4 );

		ctx.textBaseline = 'middle';
		ctx.lineJoin = 'round';
		for ( const p of places ) {

			const { x, y } = toCanvas( p.lat, p.lon );
			ctx.beginPath();
			ctx.arc( x, y, p.kind === 'shelter' ? 9 : 7, 0, Math.PI * 2 );
			ctx.fillStyle = p.kind === 'shelter' ? SHELTER_COLOR : '#1d2733';
			ctx.fill();
			ctx.strokeStyle = '#ffffff';
			ctx.lineWidth = 3;
			ctx.stroke();
			if ( p.kind === 'landmark' ) {

				ctx.font = 'bold 26px system-ui, sans-serif';
				ctx.lineWidth = 6;
				ctx.strokeText( p.name, x + 12, y );
				ctx.fillStyle = '#1d2733';
				ctx.fillText( p.name, x + 12, y );

			}

		}

		ctx.font = '20px system-ui, sans-serif';
		ctx.textAlign = 'right';
		ctx.lineWidth = 5;
		const credit = '地理院タイル　● 指定避難所';
		ctx.strokeText( credit, canvas.width - 12, canvas.height - 18 );
		ctx.fillStyle = '#1d2733';
		ctx.fillText( credit, canvas.width - 12, canvas.height - 18 );
		ctx.textAlign = 'left';
		texture.needsUpdate = true;

	}

	function toCanvas( lat: number, lon: number ) {

		const p = mercator( lat, lon, view.z );
		return { x: ( p.x - view.x0 ) * view.scale, y: ( p.y - view.y0 ) * view.scale };

	}

	// Move the arrow to where the user is. `heading` is clockwise from north, in radians.
	function setPosition( lat: number, lon: number, heading: number ) {

		const { x, y } = toCanvas( lat, lon );
		arrow.position.x = ( THREE.MathUtils.clamp( x / view.width, 0, 1 ) - 0.5 ) * mesh.scale.x;
		arrow.position.y = ( 0.5 - THREE.MathUtils.clamp( y / view.height, 0, 1 ) ) * mesh.scale.y;
		arrow.rotation.z = - heading;

	}

	return {
		object,
		setCity,
		setPosition,
		get height() { return mesh.scale.y; },
	};

}
