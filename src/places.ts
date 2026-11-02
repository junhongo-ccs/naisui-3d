import * as THREE from 'three';
import { billboard, disposeBillboard, pose, setTexture, type Billboard } from './billboard';

export type Place = {
	kind: 'landmark' | 'shelter' | 'story',
	name: string,
	town: string,
	address?: string,
	lat: number,
	lon: number,
	elevation: number, // m above the geoid
	story?: Story,
};

// What a story spot explains, in parts kept apart by kind: above all, the simulation (what the
// colors show) apart from the record (what actually happened).
// 'river' is the prefecture's simulation of the river itself overflowing (外水), and 'study' the
// city's own simulations for its sewer plans: both kept apart from 'simulation', which is what the
// colors on screen show (内水).
type StoryKind = 'terrain' | 'mechanism' | 'simulation' | 'river' | 'study' | 'record' | 'plan';
export type Story = {
	sections: { kind: StoryKind, text: string }[],
	sources: { label: string, url: string }[],
	// An everyday photo of the spot, under a free licence (Wikimedia Commons): served from
	// public/, credited on the card.
	photo?: { src: string, caption: string, author: string, license: string, url: string },
};

// src/data/places/<city code>.json, written by scripts/build-places.mjs, and
// src/data/stories/<city code>.json, written by hand.
const files = import.meta.glob<{ landmarks: Place[], shelters: Place[] }>( './data/places/*.json', { import: 'default', eager: true } );
const storyFiles = import.meta.glob<{ stories: ( Omit<Place, 'kind' | 'story'> & Story )[] }>( './data/stories/*.json', { import: 'default', eager: true } );

export function placesFor( code: string ): Place[] {

	const f = files[ `./data/places/${ code }.json` ];
	const stories = ( storyFiles[ `./data/stories/${ code }.json` ]?.stories ?? [] ).map( ( { sections, sources, photo, ...where } ): Place => ( {
		...where, kind: 'story', story: { sections, sources, photo },
	} ) );
	return [ ...( f ? [ ...f.landmarks, ...f.shelters ] : [] ), ...stories ];

}

export const SHELTER_COLOR = '#15803d';
export const STORY_COLOR = '#1d4ed8';
export const STORY_LABELS: Record<StoryKind, { label: string, color: string }> = {
	terrain: { label: '地形', color: '#64748b' },
	mechanism: { label: 'しくみ', color: '#0f766e' },
	simulation: { label: 'この色（想定）', color: '#2563eb' },
	river: { label: '川があふれた場合の想定（県。この色とは別）', color: '#7c3aed' },
	study: { label: '市の検討（シミュレーション）', color: '#475569' },
	record: { label: '実際の被害（記録）', color: '#c2410c' },
	plan: { label: 'これからの対策', color: '#15803d' },
};
const LANDMARK_BG = 'rgba(20, 26, 36, 0.86)';

// Sizes in VR, from the type scale (CLAUDE.md, 文字の大きさ), as angles of view. The cards are
// drawn at PX_PER_DEG canvas pixels per degree, so a font's px give its angle: FONT holds the
// scale's roles (title 1.8°, body 1.4°, label 1.2°, caption 1.0°).
const PX_PER_DEG = 36 / 1.4;
const FONT = {
	title: 'bold 46px system-ui, sans-serif',
	body: '36px system-ui, sans-serif',
	label: 'bold 31px system-ui, sans-serif',
	labelPlain: '31px system-ui, sans-serif',
	caption: '26px system-ui, sans-serif',
};
const LINE = { title: 64, body: 61, label: 44, caption: 42 }; // px: each role's font × its line height
// A pin's label (textLabel: 52 px text on an 84 px canvas) is drawn so its text is 1.2° (label).
const LABEL_SIZE = THREE.MathUtils.degToRad( 1.2 ) * 84 / 52; // label height / distance
const PICK_ANGLE = 0.03;
const SHELTER_NAME_RANGE = 2500; // m; farther shelters show the icon only

// The width (m) at `distance` of a card `px` wide on its canvas.
function cardWidth( px: number, distance: number ) {

	return 2 * distance * Math.tan( THREE.MathUtils.degToRad( px / PX_PER_DEG ) / 2 );

}

// Pins over a city: landmark names, so the user can tell where they are, and shelters. Each pin is
// a stem standing on the ground with a label on top, kept the same apparent size at any distance
// and drawn over the scene, so a landmark behind a hill still shows which way it is.
// In VR, pointing at a pin and pulling the trigger opens a card describing it; a story's card
// shows one part at a time, turned with its ◀ ▶ buttons, and its × button (or the pin again)
// closes it. On a flat screen only the stems are drawn here; the labels and descriptions are HTML
// (src/screen-pins.ts, src/place-dialog.ts).
export function createPins() {

	const group = new THREE.Group();
	const card = billboard( null, 0.5, - 0.08, 1002 );
	card.obj.visible = false;
	group.add( card.obj );
	// Where the card's buttons and grab strip are on its canvas.
	let cardLayout: CardLayout = { width: 1, height: 1, close: { x: 0, y: 0, w: 0, h: 0 }, prev: null, next: null, grabHeight: 0 };
	let page = 0; // of the open story's card
	let hoveredPart: CardPart | null = null; // lit while pointed at
	// Where the user has put the card by dragging its top strip, instead of at its pin; and while
	// dragging, the point grabbed (on the card, 0..1) and how far along the ray it is.
	let movedTo: THREE.Vector3 | null = null;
	let drag: { u: number, v: number, distance: number } | null = null;

	type Pin = {
		place: Place,
		base: THREE.Vector3,
		head: THREE.Vector3,
		stem: THREE.Line,
		icon: Billboard,
		name: Billboard | null, // shelters and stories: the name next to the icon
		height: number, // of the icon, as last drawn
	};
	let pins: Pin[] = [];
	let hovered: Pin | null = null;
	let opened: Pin | null = null;
	let cityName = '';
	const stemMaterial = new THREE.LineBasicMaterial( { color: '#ffffff', transparent: true, opacity: 0.85, depthTest: false } );

	// `places` in `city`, positioned by `toLocal` (lat, lon, height above the geoid → scene meters).
	function setPlaces( city: string, places: Place[], toLocal: ( lat: number, lon: number, elevation: number ) => THREE.Vector3 ) {

		cityName = city;
		for ( const p of pins ) {

			disposeBillboard( p.icon );
			if ( p.name ) disposeBillboard( p.name );
			p.stem.geometry.dispose();
			group.remove( p.stem, p.icon.obj, ...( p.name ? [ p.name.obj ] : [] ) );

		}

		hovered = opened = null;
		card.obj.visible = false;
		pins = places.map( place => {

			const base = toLocal( place.lat, place.lon, place.elevation );
			const stem = new THREE.Line(
				new THREE.BufferGeometry().setFromPoints( [ new THREE.Vector3(), new THREE.Vector3( 0, 1, 0 ) ] ),
				stemMaterial,
			);
			stem.position.copy( base );
			stem.renderOrder = 1001;
			const color = place.kind === 'shelter' ? SHELTER_COLOR : STORY_COLOR;
			const icon = billboard( place.kind === 'landmark' ? textLabel( place.name, LANDMARK_BG ) : place.kind === 'shelter' ? shelterIcon() : storyIcon(), 0.5, 0, 1001 );
			const name = place.kind === 'landmark' ? null : billboard( textLabel( place.kind === 'story' ? `解説: ${ place.name }` : place.name, color ), 0, 0, 1001 );
			// To the right of the round icon (as wide and as tall as the label). Centers are
			// fractions of the label's own size.
			name?.center.set( - 0.55 / name.aspect, 0 );
			group.add( stem, icon.obj, ...( name ? [ name.obj ] : [] ) );
			return { place, base, head: base.clone(), stem, icon, name, height: 0 };

		} );

	}

	// Resize the pins for the eye's distance and turn them to face it (in VR), or to lie flat in the
	// screen, given the camera's rotation as `facing` (on a PC or phone). Call every frame before
	// rendering.
	// On a flat screen the stems, too, stand along the camera's up rather than straight up, so they
	// stay upright and parallel on screen instead of converging below the view.
	// Without `labels` only the stems are drawn: on a flat screen the labels are HTML over the
	// canvas (src/screen-pins.ts), standing on the stems' heads.
	function update( eye: THREE.Vector3, facing: THREE.Quaternion | null, labels = true ) {

		pinUp.set( 0, 1, 0 );
		if ( facing ) pinUp.applyQuaternion( facing );
		for ( const p of pins ) {

			const d = eye.distanceTo( p.base );
			p.height = Math.max( d * LABEL_SIZE, 0.05 ) * ( p === hovered ? 1.3 : 1 );
			const stemHeight = THREE.MathUtils.clamp( d * 0.05, 3, 400 );
			p.stem.scale.y = stemHeight;
			p.stem.visible = true;
			if ( facing ) p.stem.quaternion.copy( facing );
			else p.stem.quaternion.identity();
			p.head.copy( p.base ).addScaledVector( pinUp, stemHeight );
			p.icon.obj.visible = labels;
			pose( p.icon, p.head, p.height, eye, facing );
			if ( p.name ) {

				p.name.obj.visible = labels && ( p.place.kind === 'story' || d < SHELTER_NAME_RANGE || p === hovered || p === opened );
				pose( p.name, p.head, p.height, eye, facing );

			}

		}

		if ( opened ) {

			// A story's card is tall, so it is centered on the pin's label (about eye level) rather
			// than above it, where it would mean looking far up. Moved, it stays where it was put.
			if ( movedTo ) cardAnchor.copy( movedTo );
			else cardAnchor.copy( opened.head ).addScaledVector( pinUp, eye.distanceTo( opened.head ) * LABEL_SIZE * 1.4 );
			const w = cardWidth( cardLayout.width, eye.distanceTo( cardAnchor ) );
			card.center.set( 0.5, opened.place.kind === 'story' ? 0.5 : - 0.08 );
			pose( card, cardAnchor, w / card.aspect, eye, facing );

		}

	}

	const cardAnchor = new THREE.Vector3();
	const pinUp = new THREE.Vector3( 0, 1, 0 ); // which way the pins stand, as last drawn

	// The pin a ray points at (within a small angle of its label), nearest first.
	const toHead = new THREE.Vector3();
	function pick( ray: THREE.Ray ): { place: Place, distance: number } | null {

		let best: Pin | null = null, bestAngle = PICK_ANGLE, bestDistance = Infinity;
		for ( const p of pins ) {

			// Aim at the middle of the label, not its bottom edge.
			toHead.copy( p.head ).addScaledVector( pinUp, p.height / 2 ).sub( ray.origin );
			const along = toHead.dot( ray.direction );
			if ( along <= 0 ) continue;
			const angle = Math.sqrt( Math.max( toHead.lengthSq() - along * along, 0 ) ) / along;
			if ( angle < bestAngle ) {

				best = p;
				bestAngle = angle;
				bestDistance = along;

			}

		}

		return best ? { place: best.place, distance: bestDistance } : null;

	}

	// Whether a ray hits the open card, and if so where: its close button, a page button, its top
	// strip (to drag it by), or elsewhere. The card is drawn over everything, so it takes the ray
	// before pins and the flood behind it.
	const cardRaycaster = new THREE.Raycaster();
	const hits: THREE.Intersection[] = [];
	function pickCard( ray: THREE.Ray ): { part: CardPart, distance: number, u: number, v: number } | null {

		if ( ! opened ) return null;
		cardRaycaster.ray.copy( ray );
		hits.length = 0;
		card.mesh.raycast( cardRaycaster, hits );
		const hit = hits[ 0 ];
		if ( ! hit?.uv ) return null;
		const x = hit.uv.x * cardLayout.width, y = ( 1 - hit.uv.y ) * cardLayout.height;
		// The buttons a little larger than drawn, to be easy to hit with a wavering hand.
		const on = ( r: Rect | null ) => {

			const slack = r ? Math.min( r.w, r.h ) * 0.25 : 0;
			return !! r && x >= r.x - slack && x <= r.x + r.w + slack && y >= r.y - slack && y <= r.y + r.h + slack;

		};
		const part: CardPart = on( cardLayout.close ) ? 'close' : on( cardLayout.prev ) ? 'prev' : on( cardLayout.next ) ? 'next' : y <= cardLayout.grabHeight ? 'grab' : 'card';
		return { part, distance: hit.distance, u: hit.uv.x, v: hit.uv.y };

	}

	// Turn the open story's card a page back (-1) or on (+1).
	function flip( delta: number ) {

		const story = opened?.place.story;
		if ( ! story ) return;
		page = THREE.MathUtils.clamp( page + delta, 0, storyPages( story ).length - 1 );
		draw();

	}

	// Light up the part of the card pointed at (VR): a button or the grab strip.
	function hoverPart( part: CardPart | null ) {

		if ( part === 'card' ) part = null;
		if ( part === hoveredPart ) return;
		hoveredPart = part;
		if ( opened ) draw();

	}

	// Drag the card by its top strip: start where `ray` hits the strip (false if it doesn't), move
	// so the grabbed point follows the ray at the same distance, and let go.
	function startDrag( ray: THREE.Ray ) {

		const hit = pickCard( ray );
		if ( hit?.part !== 'grab' ) return false;
		drag = { u: hit.u, v: hit.v, distance: hit.distance };
		hoverPart( 'grab' );
		return true;

	}

	const grabbed = new THREE.Vector3(), right = new THREE.Vector3(), up = new THREE.Vector3();
	function dragTo( ray: THREE.Ray ) {

		if ( ! drag ) return;
		ray.at( drag.distance, grabbed );
		// The card's anchor is offset from the grabbed point along the card's own axes, by the
		// grabbed point's place on the card and the card's size as last drawn.
		card.obj.updateMatrixWorld();
		right.setFromMatrixColumn( card.obj.matrixWorld, 0 ).normalize();
		up.setFromMatrixColumn( card.obj.matrixWorld, 1 ).normalize();
		const w = card.mesh.scale.x, h = card.mesh.scale.y;
		movedTo = ( movedTo ?? new THREE.Vector3() ).copy( grabbed )
			.addScaledVector( right, - ( drag.u - card.center.x ) * w )
			.addScaledVector( up, - ( drag.v - card.center.y ) * h );

	}

	function endDrag() {

		drag = null;

	}

	function hover( place: Place | null ) {

		hovered = pins.find( p => p.place === place ) ?? null;

	}

	// Open the card for a place, or close it if it is already open.
	function toggle( place: Place ) {

		const pin = pins.find( p => p.place === place ) ?? null;
		opened = opened === pin ? null : pin;
		card.obj.visible = !! opened;
		hoveredPart = null;
		movedTo = drag = null;
		page = 0;
		if ( opened ) draw();

	}

	function draw() {

		if ( ! opened ) return;
		const story = opened.place.story;
		if ( ! story ) {

			show( drawCard( opened.place, cityName, hoveredPart ) );
			return;

		}

		// Photos load when first opened; the card shows without it until then.
		const photo = story.photo && loadPhoto( story.photo.src );
		show( drawStoryCard( opened.place, story, page, photo?.complete ? photo : null, hoveredPart ) );
		if ( photo && ! photo.complete ) {

			const shown = opened;
			photo.addEventListener( 'load', () => {

				if ( opened === shown ) draw();

			}, { once: true } );

		}

	}

	function show( { canvas, layout }: { canvas: HTMLCanvasElement, layout: CardLayout } ) {

		setTexture( card, canvas );
		cardLayout = layout;

	}

	function close() {

		opened = null;
		card.obj.visible = false;
		hoveredPart = null;
		movedTo = drag = null;

	}

	// Where each pin stands on the ground, and where its label stands (the top of its stem) as
	// last drawn.
	function heads(): readonly { place: Place, base: THREE.Vector3, head: THREE.Vector3 }[] {

		return pins;

	}

	// Show only the stems whose labels are shown (on a phone, where crowded labels are left out),
	// by the pins' order. Call after update.
	function showStems( shown: readonly boolean[] ) {

		pins.forEach( ( p, i ) => ( p.stem.visible = shown[ i ] ) );

	}

	return { group, setPlaces, update, heads, showStems, pick, pickCard, flip, hoverPart, startDrag, dragTo, endDrag, get dragging() { return !! drag; }, get isOpen() { return !! opened; }, hover, toggle, close };

}

// A rounded label with white text.
function textLabel( text: string, background: string ) {

	const font = 'bold 52px system-ui, sans-serif';
	const canvas = document.createElement( 'canvas' );
	const ctx = canvas.getContext( '2d' )!;
	ctx.font = font;
	const pad = 26, h = 84;
	canvas.width = Math.ceil( ctx.measureText( text ).width + pad * 2 );
	canvas.height = h;
	ctx.fillStyle = background;
	ctx.beginPath();
	ctx.roundRect( 0, 0, canvas.width, h, 20 );
	ctx.fill();
	ctx.font = font;
	ctx.fillStyle = '#ffffff';
	ctx.textBaseline = 'middle';
	ctx.fillText( text, pad, h / 2 + 2 );
	return canvas;

}

// A white house on a green disc.
function shelterIcon() {

	const canvas = document.createElement( 'canvas' );
	canvas.width = canvas.height = 96;
	const ctx = canvas.getContext( '2d' )!;
	ctx.fillStyle = SHELTER_COLOR;
	ctx.beginPath();
	ctx.arc( 48, 48, 44, 0, Math.PI * 2 );
	ctx.fill();
	ctx.strokeStyle = '#ffffff';
	ctx.lineWidth = 5;
	ctx.stroke();
	ctx.fillStyle = '#ffffff';
	ctx.beginPath();
	ctx.moveTo( 48, 20 );
	ctx.lineTo( 76, 46 );
	ctx.lineTo( 68, 46 );
	ctx.lineTo( 68, 74 );
	ctx.lineTo( 28, 74 );
	ctx.lineTo( 28, 46 );
	ctx.lineTo( 20, 46 );
	ctx.closePath();
	ctx.fill();
	return canvas;

}

const photos = new Map<string, HTMLImageElement>();
function loadPhoto( src: string ) {

	let img = photos.get( src );
	if ( ! img ) {

		img = new Image();
		img.src = import.meta.env.BASE_URL + src;
		photos.set( src, img );

	}

	return img;

}

// A white "i" on a blue disc.
function storyIcon() {

	const canvas = document.createElement( 'canvas' );
	canvas.width = canvas.height = 96;
	const ctx = canvas.getContext( '2d' )!;
	ctx.fillStyle = STORY_COLOR;
	ctx.beginPath();
	ctx.arc( 48, 48, 44, 0, Math.PI * 2 );
	ctx.fill();
	ctx.strokeStyle = '#ffffff';
	ctx.lineWidth = 5;
	ctx.stroke();
	ctx.fillStyle = '#ffffff';
	ctx.font = 'bold 64px Georgia, serif';
	ctx.textAlign = 'center';
	ctx.textBaseline = 'middle';
	ctx.fillText( 'i', 48, 52 );
	return canvas;

}

// What the card says about a place.
export function describePlace( place: Place, cityName: string ): { title: string, lines: string[], notes: string[] } {

	const where = place.kind === 'shelter' ? place.address ?? '' : `${ cityName } ${ place.town }`.trim();
	const lines = [ place.kind === 'shelter' ? '指定避難所' : '目印', where, `標高 約 ${ Math.round( place.elevation ) } m` ];
	// GSI asks that whoever passes the shelter data on also passes on its cautions.
	const notes = place.kind === 'shelter' ? [
		'災害の危険がなくなるまで滞在する施設です。',
		'命を守るために緊急に逃げる先（指定緊急避難場所）とは別です。',
		'最新でない場合があります。開設状況などは市に確認してください。',
		'出典: 指定避難所データ（国土地理院）',
	] : [];
	return { title: place.name, lines, notes };

}

// Break text into lines no wider than `width` (Japanese has no spaces, so by character). Closing
// punctuation stays on the line before, even if it runs a little over, as Japanese typesetting does.
const NO_LINE_START = '、。，．）」』〕・ー';
function wrap( ctx: CanvasRenderingContext2D, text: string, width: number ): string[] {

	const lines: string[] = [];
	let line = '';
	for ( const ch of text ) {

		if ( line && ! NO_LINE_START.includes( ch ) && ctx.measureText( line + ch ).width > width ) {

			lines.push( line );
			line = '';

		}

		line += ch;

	}

	if ( line ) lines.push( line );
	return lines;

}

// The cards in VR. Their text is the type scale's (FONT, LINE); a card is CARD_W px wide (about
// 30°) and as tall as its text.
type Rect = { x: number, y: number, w: number, h: number };
// The parts of an open card that respond to pointing.
type CardPart = 'close' | 'prev' | 'next' | 'grab' | 'card';
type CardLayout = { width: number, height: number, close: Rect, prev: Rect | null, next: Rect | null, grabHeight: number };
type Row = { font: string, color: string, text: string, height: number, tag?: string, image?: { img: HTMLImageElement | null, w: number, h: number } };

const CARD_W = 760; // px: about 30°
const PAD = 28; // px
const TEXT_W = CARD_W - PAD * 2 - 8; // px: room for punctuation that hangs over
const BUTTON = 62; // px (2.4°): the height of the close and page buttons, to be easy to point at
const PAGE_BUTTON_W = 210; // px
const PHOTO_MAX_H = 440; // px
const GRAB_HEIGHT = 84; // px from the top: the strip that drags the card
const MUTED = '#9fb3c8';
// While a card is open the user can turn but not move (src/vr.ts); the card says so.
const CLOSE_HINT = '× で閉じると移動できます';
const HINT_COLOR = '#fcd34d';

// The pages of a story's card: its photo (if there is one), each part, then the sources. One part
// at a time, so the text can be the scale's size and the card still fit the view.
type Page = { kind: 'photo' } | { kind: 'section', section: Story[ 'sections' ][ number ] } | { kind: 'sources' };
function storyPages( story: Story ): Page[] {

	return [
		...( story.photo ? [ { kind: 'photo' } as const ] : [] ),
		...story.sections.map( section => ( { kind: 'section', section } as const ) ),
		{ kind: 'sources' },
	];

}

function pageRows( ctx: CanvasRenderingContext2D, story: Story, page: Page, photo: HTMLImageElement | null ): Row[] {

	switch ( page.kind ) {

		case 'photo': {

			// Until the photo has loaded, a placeholder as tall as the photo may be.
			const { caption, author, license } = story.photo!;
			const scale = photo ? Math.min( TEXT_W / photo.naturalWidth, PHOTO_MAX_H / photo.naturalHeight ) : 0;
			const w = photo ? photo.naturalWidth * scale : TEXT_W, h = photo ? photo.naturalHeight * scale : PHOTO_MAX_H;
			return [
				{ font: FONT.caption, color: '', text: '', height: h + 12, image: { img: photo, w, h } },
				...textRows( ctx, caption, FONT.caption, '#c8d6e5', LINE.caption ),
				...textRows( ctx, `写真: ${ author }（${ license }、Wikimedia Commons）`, FONT.caption, MUTED, LINE.caption ),
			];

		}

		case 'section': {

			const { label, color } = STORY_LABELS[ page.section.kind ];
			return [
				{ font: FONT.label, color: '#ffffff', text: label, height: LINE.label + 12, tag: color },
				...textRows( ctx, page.section.text, FONT.body, '#e5edf5', LINE.body ),
			];

		}

		case 'sources':
			return [
				{ font: FONT.label, color: MUTED, text: '出典', height: LINE.label },
				...story.sources.flatMap( s => textRows( ctx, `・${ s.label }`, FONT.caption, MUTED, LINE.caption ) ),
			];

	}

}

// A story's card, at `page`: the title and where it is, the page, and under it ◀ 前へ, which page
// of how many, 次へ ▶. Every page is as tall as the tallest, so the buttons stay put as the pages
// turn.
function drawStoryCard( place: Place, story: Story, page: number, photo: HTMLImageElement | null, hovered: CardPart | null ) {

	const canvas = document.createElement( 'canvas' );
	const ctx = canvas.getContext( '2d' )!;
	const pages = storyPages( story );
	const p = THREE.MathUtils.clamp( page, 0, pages.length - 1 );
	const head = [
		...textRows( ctx, place.name, FONT.title, '#ffffff', LINE.title, TEXT_W - BUTTON - 12 ),
		...textRows( ctx, `${ place.town }　標高 約 ${ Math.round( place.elevation ) } m`, FONT.caption, MUTED, LINE.caption ),
	];
	const pageHeight = Math.max( ...pages.map( q => rowsHeight( pageRows( ctx, story, q, photo ) ) ) );
	const top = PAD + 12; // under the grab bar
	const pageY = top + rowsHeight( head ) + 16;
	const navY = pageY + pageHeight + 20;
	canvas.width = CARD_W;
	canvas.height = navY + BUTTON + 12 + LINE.caption + PAD - 8;
	drawCardBack( ctx, STORY_COLOR );

	ctx.textBaseline = 'top';
	drawRows( ctx, head, PAD, top );
	drawRows( ctx, pageRows( ctx, story, pages[ p ], photo ), PAD, pageY );

	const prev = { x: PAD, y: navY, w: PAGE_BUTTON_W, h: BUTTON };
	const next = { x: CARD_W - PAD - PAGE_BUTTON_W, y: navY, w: PAGE_BUTTON_W, h: BUTTON };
	drawButton( ctx, prev, '◀ 前へ', p > 0, hovered === 'prev' );
	drawButton( ctx, next, '次へ ▶', p < pages.length - 1, hovered === 'next' );
	ctx.font = FONT.labelPlain;
	ctx.fillStyle = '#e5edf5';
	ctx.textAlign = 'center';
	ctx.fillText( `${ p + 1 } / ${ pages.length }`, CARD_W / 2, navY + ( BUTTON - fontPx( FONT.labelPlain ) ) / 2 );
	ctx.textAlign = 'left';
	drawRows( ctx, textRows( ctx, CLOSE_HINT, FONT.caption, HINT_COLOR, LINE.caption ), PAD, navY + BUTTON + 12 );
	return {
		canvas,
		layout: { width: CARD_W, height: canvas.height, ...drawCardControls( ctx, CARD_W, hovered ), prev: p > 0 ? prev : null, next: p < pages.length - 1 ? next : null },
	};

}

// A landmark's or shelter's card: the title, what and where it is, and for a shelter the cautions
// GSI asks to pass on.
function drawCard( place: Place, cityName: string, hovered: CardPart | null ) {

	const { title, lines, notes } = describePlace( place, cityName );
	const canvas = document.createElement( 'canvas' );
	const ctx = canvas.getContext( '2d' )!;
	const head = textRows( ctx, title, FONT.title, '#ffffff', LINE.title, TEXT_W - BUTTON - 12 );
	const body = lines.filter( Boolean ).flatMap( line => textRows( ctx, line, FONT.body, '#dbe7f3', LINE.body ) );
	const small = notes.flatMap( note => textRows( ctx, note, FONT.caption, MUTED, LINE.caption ) );
	const hint = textRows( ctx, CLOSE_HINT, FONT.caption, HINT_COLOR, LINE.caption );
	const top = PAD + 12;
	const bodyY = top + rowsHeight( head ) + 8;
	const smallY = bodyY + rowsHeight( body ) + 12;
	const hintY = smallY + rowsHeight( small ) + ( small.length ? 12 : 0 );
	canvas.width = CARD_W;
	canvas.height = hintY + rowsHeight( hint ) + PAD - 8;
	drawCardBack( ctx, place.kind === 'shelter' ? SHELTER_COLOR : null );

	ctx.textBaseline = 'top';
	drawRows( ctx, head, PAD, top );
	drawRows( ctx, body, PAD, bodyY );
	drawRows( ctx, small, PAD, smallY );
	drawRows( ctx, hint, PAD, hintY );
	return { canvas, layout: { width: CARD_W, height: canvas.height, ...drawCardControls( ctx, CARD_W, hovered ), prev: null, next: null } };

}

// `text` broken into rows of `font`, each `height` tall.
function textRows( ctx: CanvasRenderingContext2D, text: string, font: string, color: string, height: number, width = TEXT_W ): Row[] {

	ctx.font = font;
	return wrap( ctx, text, width ).map( line => ( { font, color, text: line, height } ) );

}

function rowsHeight( rows: Row[] ) {

	return rows.reduce( ( h, r ) => h + r.height, 0 );

}

function fontPx( font: string ) {

	return Number( /(\d+)px/.exec( font )![ 1 ] );

}

// Draw `rows` from (x, y) down, each line's text centered in its row.
function drawRows( ctx: CanvasRenderingContext2D, rows: Row[], x: number, y: number ) {

	for ( const r of rows ) {

		ctx.font = r.font;
		const size = fontPx( r.font );
		if ( r.image ) {

			if ( r.image.img ) {

				ctx.drawImage( r.image.img, x, y, r.image.w, r.image.h );

			} else {

				ctx.fillStyle = 'rgba(255, 255, 255, 0.06)';
				ctx.fillRect( x, y, r.image.w, r.image.h );

			}

		} else if ( r.tag ) {

			ctx.fillStyle = r.tag;
			ctx.beginPath();
			ctx.roundRect( x, y, ctx.measureText( r.text ).width + 28, LINE.label, 10 );
			ctx.fill();
			ctx.fillStyle = r.color;
			ctx.fillText( r.text, x + 14, y + ( LINE.label - size ) / 2 );

		} else {

			ctx.fillStyle = r.color;
			ctx.fillText( r.text, x, y + ( r.height - size ) / 2 );

		}

		y += r.height;

	}

}

// The card's dark ground, with a stripe of `stripe` down the left side.
function drawCardBack( ctx: CanvasRenderingContext2D, stripe: string | null ) {

	const { width, height } = ctx.canvas;
	ctx.fillStyle = 'rgba(20, 26, 36, 0.94)';
	ctx.beginPath();
	ctx.roundRect( 0, 0, width, height, 28 );
	ctx.fill();
	if ( ! stripe ) return;
	ctx.fillStyle = stripe;
	ctx.fillRect( 0, 24, 12, height - 48 );

}

// A rounded button: lit while pointed at, faint when it can't be used.
function drawButton( ctx: CanvasRenderingContext2D, r: Rect, text: string, enabled: boolean, lit: boolean ) {

	ctx.fillStyle = lit && enabled ? '#ffffff' : enabled ? 'rgba(255, 255, 255, 0.16)' : 'rgba(255, 255, 255, 0.05)';
	ctx.beginPath();
	ctx.roundRect( r.x, r.y, r.w, r.h, r.h / 2 );
	ctx.fill();
	ctx.font = FONT.label;
	ctx.fillStyle = lit && enabled ? '#141a24' : enabled ? '#ffffff' : 'rgba(255, 255, 255, 0.3)';
	ctx.textAlign = 'center';
	ctx.fillText( text, r.x + r.w / 2, r.y + ( r.h - fontPx( FONT.label ) ) / 2 );
	ctx.textAlign = 'left';

}

// A round × button in the card's top right corner, and a bar along the top middle that marks the
// strip to drag the card by; each lit while pointed at.
function drawCardControls( ctx: CanvasRenderingContext2D, width: number, hovered: CardPart | null ) {

	const barWidth = 200;
	ctx.fillStyle = hovered === 'grab' ? '#ffffff' : 'rgba(255, 255, 255, 0.35)';
	ctx.beginPath();
	ctx.roundRect( ( width - barWidth ) / 2, 12, barWidth, 10, 5 );
	ctx.fill();

	const x = width - PAD - BUTTON + 8, y = 22, r = BUTTON / 2;
	ctx.fillStyle = hovered === 'close' ? '#ffffff' : 'rgba(255, 255, 255, 0.16)';
	ctx.beginPath();
	ctx.arc( x + r, y + r, r, 0, Math.PI * 2 );
	ctx.fill();
	ctx.strokeStyle = hovered === 'close' ? '#141a24' : '#ffffff';
	ctx.lineWidth = 6;
	ctx.lineCap = 'round';
	const a = r * 0.42;
	ctx.beginPath();
	ctx.moveTo( x + r - a, y + r - a );
	ctx.lineTo( x + r + a, y + r + a );
	ctx.moveTo( x + r + a, y + r - a );
	ctx.lineTo( x + r - a, y + r + a );
	ctx.stroke();
	return { close: { x, y, w: BUTTON, h: BUTTON }, grabHeight: GRAB_HEIGHT };

}
