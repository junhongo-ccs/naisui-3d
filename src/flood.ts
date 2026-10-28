import { Color } from 'three';

// Municipalities label depth bins in their own words ("0.5m以上3m未満", "5cm～20cm未満",
// "0.0m～0.2m未満の区域", "3.0m以上"). Parse any of them into a [min, max) range in meters.
export function parseDepthLabel( label: string ): [ number, number ] | null {

	const nums = [ ...label.matchAll( /(\d+(?:\.\d+)?)\s*(cm|ｃｍ|m|ｍ)/g ) ]
		.map( m => Number( m[ 1 ] ) * ( m[ 2 ].startsWith( 'c' ) || m[ 2 ].startsWith( 'ｃ' ) ? 0.01 : 1 ) );

	if ( nums.length >= 2 ) return [ nums[ 0 ], nums[ 1 ] ];
	if ( nums.length === 1 ) return label.includes( '未満' ) ? [ 0, nums[ 0 ] ] : [ nums[ 0 ], Infinity ];
	return null;

}

// MLIT flood-depth palette (水害ハザードマップ作成の手引き), placed at the middle of each
// standard bin so the standard ranks get the official colors and finer local bins fall between them.
const STOPS: Array<[ number, Color ]> = [
	[ 0.25, new Color( '#f7f5a9' ) ],
	[ 1.75, new Color( '#ffd8c0' ) ],
	[ 4, new Color( '#ffb7b7' ) ],
	[ 7.5, new Color( '#ff9191' ) ],
	[ 15, new Color( '#f285c9' ) ],
	[ 20, new Color( '#dc7adc' ) ],
];

export function depthColor( range: [ number, number ] | null, target = new Color() ): Color {

	if ( ! range ) return target.set( '#9ecae1' );

	const [ lo, hi ] = range;
	const d = Number.isFinite( hi ) ? ( lo + hi ) / 2 : Math.max( lo * 1.25, lo + 0.5 );
	if ( d <= STOPS[ 0 ][ 0 ] ) return target.copy( STOPS[ 0 ][ 1 ] );

	for ( let i = 1; i < STOPS.length; i ++ ) {

		const [ d1, c1 ] = STOPS[ i ];
		if ( d <= d1 ) {

			const [ d0, c0 ] = STOPS[ i - 1 ];
			return target.copy( c0 ).lerp( c1, ( d - d0 ) / ( d1 - d0 ) );

		}

	}

	return target.copy( STOPS[ STOPS.length - 1 ][ 1 ] );

}

// Pick the label a feature should be colored by: the municipality's own bin when present,
// otherwise the standard PLATEAU rank.
export function featureLabel( rankOrg: unknown, rank: unknown ): string {

	const ok = ( v: unknown ) => typeof v === 'string' && v !== '' && v !== 'None';
	if ( ok( rankOrg ) ) return rankOrg as string;
	if ( ok( rank ) ) return rank as string;
	return '不明';

}
