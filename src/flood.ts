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

// Pale water blue for shallow → deep navy for deep, keyed on the middle of each bin.
// Inland flooding is mostly under 3 m, so the stops are packed below that.
const STOPS: Array<[ number, Color ]> = [
	[ 0.05, new Color( '#d4ecfb' ) ],
	[ 0.25, new Color( '#a9d6f5' ) ],
	[ 0.5, new Color( '#74b9ec' ) ],
	[ 1, new Color( '#3f93dc' ) ],
	[ 2, new Color( '#1f69c2' ) ],
	[ 4, new Color( '#0d4597' ) ],
	[ 8, new Color( '#082a66' ) ],
];

export function depthColor( range: [ number, number ] | null, target = new Color() ): Color {

	if ( ! range ) return target.set( '#a0a0a0' );

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

// How far to raise the water surface for a depth bin: the top of the bin ("0.5m未満" → 0.5 m),
// or its floor when it is open-ended ("3.0m以上" → 3 m). Unknown depth stays on the ground.
export function surfaceHeight( range: [ number, number ] | null ): number {

	if ( ! range ) return 0;
	return Number.isFinite( range[ 1 ] ) ? range[ 1 ] : range[ 0 ];

}

// Pick the label a feature should be colored by: the municipality's own bin when present,
// otherwise the standard PLATEAU rank.
export function featureLabel( rankOrg: unknown, rank: unknown ): string {

	const ok = ( v: unknown ) => typeof v === 'string' && v !== '' && v !== 'None';
	if ( ok( rankOrg ) ) return rankOrg as string;
	if ( ok( rank ) ) return rank as string;
	return '不明';

}
