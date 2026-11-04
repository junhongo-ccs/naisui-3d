import { MVTOverlay } from '3d-tiles-renderer/three/plugins';

// The map under /plateau's plain buildings: OpenStreetMap, from OpenFreeMap's vector tiles, drawn
// in our own colors and without text. Text inside a map image grows and shrinks with the view, and
// can't keep the type scale (CLAUDE.md); the names go up as labels instead (src/data/names/).
// Colors are kept pale, so the gray buildings stand out; the water is gray, as the floods are blue.

const TILEJSON = 'https://tiles.openfreemap.org/planet';
const LEVELS = 15; // the tiles' finest is z14; the overlay draws them sharper from there
const RESOLUTION = 1024; // px per ground tile's map: the streets stay clear from above
const TILE_EXTENT = 4096; // a vector tile's own units

const LAND = '#f4f1ea', WATER = '#cfd8de', GREEN = '#d6e6c8', ROAD = '#ffffff', MAJOR_ROAD = '#f6d58a', RAIL = '#a9aeb6';

// Thicker roads for bigger classes, in px on the map's image.
const ROAD_WIDTH: Record<string, number> = { motorway: 7, trunk: 7, primary: 6, secondary: 5, tertiary: 4, minor: 3, service: 2 };
const MAJOR = new Set( [ 'motorway', 'trunk', 'primary', 'secondary' ] );
const GREEN_LAND = new Set( [ 'wood', 'grass', 'farmland', 'wetland' ] );
const GREEN_USE = new Set( [ 'park', 'cemetery', 'pitch', 'garden' ] );

type Properties = Record<string, unknown> | null;

// Layers are drawn in `order`; a layer not here isn't drawn (buildings stand in 3D, and names and
// house numbers are text).
function style( layer: string, p: Properties ) {

	switch ( layer ) {

		case 'landcover': return p && ! GREEN_LAND.has( p.class as string ) ? null : { fill: GREEN, order: 1 };
		case 'landuse': return p && ! GREEN_USE.has( p.class as string ) ? null : { fill: GREEN, order: 2 };
		case 'park': return { fill: GREEN, order: 2 };
		case 'water': return { fill: WATER, order: 3 };
		case 'waterway': return { fill: 'transparent', stroke: WATER, strokeWidth: 3, order: 4 };
		case 'transportation': {

			const kind = p?.class as string;
			if ( kind === 'rail' ) return { fill: 'transparent', stroke: RAIL, strokeWidth: 2, order: 6 };
			if ( p && ! ( kind in ROAD_WIDTH ) ) return null;
			return { fill: 'transparent', stroke: MAJOR.has( kind ) ? MAJOR_ROAD : ROAD, strokeWidth: ROAD_WIDTH[ kind ] ?? 2, order: 5 };

		}

		default: return null;

	}

}

// OpenFreeMap's tile URL has its build's date in it, so ask for today's. Null if it can't be
// reached: it comes with no guarantee of service, and the page falls back on the GSI map.
export async function plainMapTiles(): Promise<string | null> {

	try {

		const res = await fetch( TILEJSON );
		return res.ok ? ( await res.json() ).tiles[ 0 ] : null;

	} catch {

		return null;

	}

}

export function createPlainMap( url: string ) {

	const overlay = new MVTOverlay( { url, levels: LEVELS, resolution: RESOLUTION, getStyle: style } );
	// Lay the land's color first: the tiles only have shapes for green and water, and what's left
	// clear would show black. The library has no option for a background, and clears each tile's
	// square just before drawing it, so it goes in here, where the frame is the tile's own.
	type Source = { _canvasRenderer: { _ctx: CanvasRenderingContext2D }, _renderVectorTile( tile: unknown ): void };
	const source = ( overlay as unknown as { imageSource: Source } ).imageSource;
	const render = source._renderVectorTile;
	source._renderVectorTile = function ( tile ) {

		const ctx = this._canvasRenderer._ctx;
		ctx.fillStyle = LAND;
		ctx.fillRect( 0, 0, TILE_EXTENT, TILE_EXTENT );
		render.call( this, tile );

	};

	return overlay;

}
