import * as THREE from 'three';
import type { Place } from './places';

// The pins' labels on a PC or phone: HTML over the canvas, standing on the 3D stems' heads, so the
// text keeps the sizes of the type scale (CLAUDE.md) and follows the browser's zoom; in VR the
// labels are in the scene (src/places.ts). A small icon (or, for a landmark, its name), but a tap
// or click anywhere near it counts, so it is easy to hit without covering the map. The labels let
// touches and clicks through, so a drag that starts on one still turns the view; taps are
// matched to them by position (pick).
// Icons that would overlap are gathered into one disc showing how many there are; tapped, the
// view closes in on them (src/main.ts). Names are shown only where there is room: story names,
// then landmarks, then shelter names, each left out where it would overlap one already placed.

const ICON = 26; // px, the icon's diameter as drawn
const CLUSTER = 30; // px, a gathered disc's diameter
const TAP_RADIUS = 28; // px from the icon's center that a tap reaches
const TAP_SLACK = 8; // px around a name label that a tap reaches

type Rect = { x: number, y: number, w: number, h: number };
type Marker = {
	place: Place,
	el: HTMLElement,
	name: HTMLElement | null, // stories and shelters: the name next to the icon
	nameSize: { w: number, h: number },
	visible: boolean, // on screen and in front of the camera
	x: number, y: number, // the stem's head on screen, px
	icon: Rect | null, // where the icon (or landmark label) is drawn, if it is on its own
	label: Rect | null, // where the name is drawn, if it is
};
// Icons drawn as one: at the first one's place, which keeps its stem.
type Group = { members: Marker[], rect: Rect, solo: boolean };

export type ScreenPick = { place: Place } | { cluster: Place[] };

export function createScreenPins( layer: HTMLElement ) {

	let markers: Marker[] = [];
	let groups: Group[] = [];
	const discs: HTMLElement[] = []; // the gathered discs' elements, reused frame to frame
	let active: Place | null = null;

	function setPlaces( places: readonly Place[] ) {

		layer.replaceChildren();
		discs.length = 0;
		groups = [];
		markers = places.map( place => {

			const el = document.createElement( 'div' );
			el.className = `pin pin-${ place.kind }${ place.range ? ' pin-map' : '' }`;
			let name: HTMLElement | null = null;
			if ( place.kind === 'landmark' ) {

				el.textContent = place.name;

			} else {

				const icon = document.createElement( 'span' );
				icon.className = 'pin-icon';
				icon.setAttribute( 'aria-hidden', 'true' );
				name = document.createElement( 'span' );
				name.className = 'pin-name';
				name.textContent = place.name;
				el.append( icon, name );

			}

			layer.append( el );
			return { place, el, name, nameSize: { w: 0, h: 0 }, visible: false, x: 0, y: 0, icon: null, label: null };

		} );

		measure();

	}

	// Measure the labels for laying them out. Their text doesn't change, but their size does with
	// the browser's zoom: call again on resize.
	function measure() {

		for ( const m of markers ) {

			const hidden = [ m.el.hidden, m.name?.hidden ?? false ];
			m.el.hidden = false;
			if ( m.name ) m.name.hidden = false;
			const r = ( m.name ?? m.el ).getBoundingClientRect();
			m.nameSize = { w: r.width, h: r.height };
			m.el.hidden = hidden[ 0 ];
			if ( m.name ) m.name.hidden = hidden[ 1 ];

		}

	}

	const v = new THREE.Vector3();
	// Place the labels on the stems' heads (`heads`, in the same order as the places given) as seen by
	// `camera`. Call every frame after the pins are updated. Returns which stems to show: those of
	// the labels shown on their own, and of the first of each gathered disc.
	function update( camera: THREE.Camera, heads: readonly { head: THREE.Vector3, near: boolean }[] ): boolean[] {

		const W = window.innerWidth, H = window.innerHeight;
		for ( let i = 0; i < markers.length; i ++ ) {

			const m = markers[ i ];
			v.copy( heads[ i ].head ).project( camera );
			m.x = ( v.x + 1 ) / 2 * W;
			m.y = ( 1 - v.y ) / 2 * H;
			m.visible = heads[ i ].near && v.z < 1 && m.x > - 100 && m.x < W + 100 && m.y > - 50 && m.y < H + 50;
			m.icon = m.label = null;

		}

		// Gather the icons, nearest the bottom of the screen (nearest the eye) first. The open one
		// stays on its own.
		const icons = markers.filter( m => m.visible && m.place.kind !== 'landmark' )
			.sort( ( a, b ) => Number( b.place === active ) - Number( a.place === active ) || b.y - a.y );
		groups = [];
		for ( const m of icons ) {

			const solo = m.place === active;
			const group = solo ? null : groups.find( g => ! g.solo && Math.abs( g.members[ 0 ].x - m.x ) < ICON + 2 && Math.abs( g.members[ 0 ].y - m.y ) < ICON + 2 );
			if ( group ) group.members.push( m );
			else groups.push( { members: [ m ], rect: { x: m.x - ICON / 2, y: m.y - ICON, w: ICON, h: ICON }, solo } );

		}

		for ( const g of groups ) {

			if ( g.members.length === 1 ) {

				g.members[ 0 ].icon = g.rect;

			} else {

				const { x, y } = g.members[ 0 ];
				g.rect = { x: x - CLUSTER / 2, y: y - CLUSTER, w: CLUSTER, h: CLUSTER };

			}

		}

		// Then the names, where there is room.
		const placed = groups.map( g => g.rect );
		const free = ( r: Rect ) => placed.every( p => r.x + r.w <= p.x || p.x + p.w <= r.x || r.y + r.h <= p.y || p.y + p.h <= r.y );
		// A pin before a map's names, and the names that reach furthest (the ones that matter most) first.
		const reach = ( m: Marker ) => m.place.range ?? 1e9;
		const byKind = ( kind: Place[ 'kind' ] ) => markers.filter( m => m.visible && m.place.kind === kind )
			.sort( ( a, b ) => Number( b.place === active ) - Number( a.place === active ) || reach( b ) - reach( a ) || b.y - a.y );
		for ( const kind of [ 'story', 'landmark', 'shelter' ] as const ) {

			for ( const m of byKind( kind ) ) {

				if ( kind !== 'landmark' && ! m.icon ) continue; // gathered
				const { w, h } = m.nameSize;
				const r = kind === 'landmark'
					? { x: m.x - w / 2, y: m.y - h, w, h }
					: { x: m.x + ICON / 2 + 3, y: m.y - ( ICON + h ) / 2, w, h };
				if ( m.place !== active && ! free( r ) ) continue;
				placed.push( r );
				if ( kind === 'landmark' ) m.icon = r;
				else m.label = r;

			}

		}

		for ( const m of markers ) {

			m.el.hidden = ! m.icon;
			if ( ! m.icon ) continue;
			m.el.style.transform = `translate(${ m.icon.x.toFixed( 1 ) }px, ${ m.icon.y.toFixed( 1 ) }px)`;
			m.el.classList.toggle( 'pin-active', m.place === active );
			if ( m.name ) m.name.hidden = ! m.label;

		}

		const gathered = groups.filter( g => g.members.length > 1 );
		gathered.forEach( ( g, i ) => {

			const disc = discs[ i ] ?? addDisc();
			const kinds = new Set( g.members.map( m => m.place.kind ) );
			disc.className = `pin pin-cluster pin-cluster-${ kinds.size > 1 ? 'mixed' : [ ...kinds ][ 0 ] }`;
			disc.firstElementChild!.textContent = String( g.members.length );
			disc.style.transform = `translate(${ g.rect.x.toFixed( 1 ) }px, ${ g.rect.y.toFixed( 1 ) }px)`;
			disc.hidden = false;

		} );
		for ( let i = gathered.length; i < discs.length; i ++ ) discs[ i ].hidden = true;

		const firsts = new Set( groups.map( g => g.members[ 0 ] ) );
		return markers.map( m => ! m.place.range && ( !! m.icon || firsts.has( m ) ) );

	}

	function addDisc() {

		const disc = document.createElement( 'div' );
		disc.append( document.createElement( 'span' ) );
		disc.firstElementChild!.className = 'pin-icon';
		layer.append( disc );
		discs.push( disc );
		return disc;

	}

	// What a tap at (x, y) is for: the place whose label is nearest, or the places gathered in a
	// disc; nothing if it is near none.
	function pick( x: number, y: number ): ScreenPick | null {

		// Distance from the tap to a rectangle's center, or to its nearest edge (0 inside), if no
		// more than `limit`.
		const within = ( d: number, limit: number ) => ( d <= limit ? d : Infinity );
		const toCenter = ( r: Rect | null ) => ( r ? Math.hypot( x - r.x - r.w / 2, y - r.y - r.h / 2 ) : Infinity );
		const toEdge = ( r: Rect | null ) => ( r ? Math.hypot( Math.max( r.x - x, 0, x - r.x - r.w ), Math.max( r.y - y, 0, y - r.y - r.h ) ) : Infinity );
		let best: ScreenPick | null = null, bestDistance = Infinity;
		const consider = ( pick: ScreenPick, d: number ) => {

			if ( d < bestDistance ) {

				best = pick;
				bestDistance = d;

			}

		};

		for ( const m of markers ) {

			// Landmarks give way to the icons they sit among.
			if ( m.place.kind === 'landmark' ) consider( { place: m.place }, within( toEdge( m.icon ), TAP_SLACK ) + 6 );
			else consider( { place: m.place }, Math.min( within( toCenter( m.icon ), TAP_RADIUS ), within( toEdge( m.label ), TAP_SLACK ) ) );

		}

		for ( const g of groups ) {

			if ( g.members.length > 1 ) consider( { cluster: g.members.map( m => m.place ) }, within( toCenter( g.rect ), TAP_RADIUS ) );

		}

		return best;

	}

	// Mark the place whose description is open.
	function setActive( place: Place | null ) {

		active = place;

	}

	return { setPlaces, measure, update, pick, setActive };

}
