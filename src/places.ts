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
type StoryKind = 'terrain' | 'mechanism' | 'simulation' | 'record' | 'plan';
type Story = {
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
const STORY_LABELS: Record<StoryKind, { label: string, color: string }> = {
	terrain: { label: '地形', color: '#64748b' },
	mechanism: { label: 'しくみ', color: '#0f766e' },
	simulation: { label: 'この色（想定）', color: '#2563eb' },
	record: { label: '実際の被害（記録）', color: '#c2410c' },
	plan: { label: 'これからの対策', color: '#15803d' },
};
const LANDMARK_BG = 'rgba(20, 26, 36, 0.86)';

// Apparent sizes, as a fraction of the distance from the eye (≈ radians).
const LABEL_SIZE = 0.028;
const CARD_WIDTH = 0.5;
const STORY_CARD_WIDTH = 0.5; // of the text column; the card is about 30° tall, so it fits the PC view (55°) and reads in VR
const PICK_ANGLE = 0.03;
const SHELTER_NAME_RANGE = 2500; // m; farther shelters show the icon only
const NAME_SCALE = 0.8; // shelter name height / icon height

// Pins over a city: landmark names, so the user can tell where they are, and shelters. Each pin is
// a stem standing on the ground with a label on top, kept the same apparent size at any distance
// and drawn over the scene, so a landmark behind a hill still shows which way it is.
// Pointing at a pin and clicking (or pulling the trigger in VR) opens a card describing it; the
// card's × button (or the pin again) closes it.
export function createPins() {

	const group = new THREE.Group();
	const card = billboard( null, 0.5, - 0.08, 1002 );
	card.obj.visible = false;
	group.add( card.obj );
	// Where the card's close button is on its canvas, and how much wider than a plain text card it
	// is (a story card with a photo has a second column).
	let cardLayout: CardLayout = { width: 1, height: 1, close: { x: 0, y: 0, size: 0 }, widthScale: 1 };
	let closeHovered = false;

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
			// To the right of the round icon (as wide as it is tall), centered on it vertically.
			// Centers are fractions of the label's own size.
			name?.center.set( - 0.55 / ( NAME_SCALE * name.aspect ), - ( 1 - NAME_SCALE ) / 2 / NAME_SCALE );
			group.add( stem, icon.obj, ...( name ? [ name.obj ] : [] ) );
			return { place, base, head: base.clone(), stem, icon, name, height: 0 };

		} );

	}

	// Resize the pins for the eye's distance and turn them to face it. Call every frame before
	// rendering.
	function update( eye: THREE.Vector3 ) {

		for ( const p of pins ) {

			const d = eye.distanceTo( p.base );
			p.height = Math.max( d * LABEL_SIZE, 0.05 ) * ( p === hovered ? 1.3 : 1 );
			const stemHeight = THREE.MathUtils.clamp( d * 0.05, 3, 400 );
			p.stem.scale.y = stemHeight;
			p.head.copy( p.base ).setY( p.base.y + stemHeight );
			pose( p.icon, p.head, p.height, eye );
			if ( p.name ) {

				p.name.obj.visible = p.place.kind === 'story' || d < SHELTER_NAME_RANGE || p === hovered || p === opened;
				pose( p.name, p.head, p.height * NAME_SCALE, eye );

			}

		}

		if ( opened ) {

			// A story's card is tall, so it is centered on the pin's label (about eye level) rather
			// than above it, where it would mean looking far up.
			const d = eye.distanceTo( opened.head );
			const w = d * ( opened.place.kind === 'story' ? STORY_CARD_WIDTH * cardLayout.widthScale : CARD_WIDTH );
			card.center.set( 0.5, opened.place.kind === 'story' ? 0.5 : - 0.08 );
			pose( card, cardAnchor.copy( opened.head ).setY( opened.head.y + d * LABEL_SIZE * 1.4 ), w / card.aspect, eye );

		}

	}

	const cardAnchor = new THREE.Vector3();

	// The pin a ray points at (within a small angle of its label), nearest first.
	const toHead = new THREE.Vector3();
	function pick( ray: THREE.Ray ): { place: Place, distance: number } | null {

		let best: Pin | null = null, bestAngle = PICK_ANGLE, bestDistance = Infinity;
		for ( const p of pins ) {

			// Aim at the middle of the label, not its bottom edge.
			toHead.copy( p.head ).setY( p.head.y + p.height / 2 ).sub( ray.origin );
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

	// Whether a ray hits the open card, and if so whether on its close button. The card is drawn
	// over everything, so it takes the ray before pins and the flood behind it.
	const cardRaycaster = new THREE.Raycaster();
	const hits: THREE.Intersection[] = [];
	function pickCard( ray: THREE.Ray ): { part: 'close' | 'card', distance: number } | null {

		if ( ! opened ) return null;
		cardRaycaster.ray.copy( ray );
		hits.length = 0;
		card.mesh.raycast( cardRaycaster, hits );
		const hit = hits[ 0 ];
		if ( ! hit?.uv ) return null;
		const x = hit.uv.x * cardLayout.width, y = ( 1 - hit.uv.y ) * cardLayout.height;
		const { close } = cardLayout;
		// A little larger than drawn, to be easy to hit with a wavering hand.
		const slack = close.size * 0.25;
		const onClose = x >= close.x - slack && x <= close.x + close.size + slack && y >= close.y - slack && y <= close.y + close.size + slack;
		return { part: onClose ? 'close' : 'card', distance: hit.distance };

	}

	// Light up the close button while it is pointed at (VR).
	function hoverClose( on: boolean ) {

		if ( on === closeHovered ) return;
		closeHovered = on;
		if ( opened ) draw();

	}

	function hover( place: Place | null ) {

		hovered = pins.find( p => p.place === place ) ?? null;

	}

	// Open the card for a place, or close it if it is already open.
	function toggle( place: Place ) {

		const pin = pins.find( p => p.place === place ) ?? null;
		opened = opened === pin ? null : pin;
		card.obj.visible = !! opened;
		closeHovered = false;
		if ( opened ) draw();

	}

	function draw() {

		if ( ! opened ) return;
		const story = opened.place.story;
		if ( ! story ) {

			show( drawCard( opened.place, cityName, closeHovered ) );
			return;

		}

		// Photos load when first opened; the card shows without it until then.
		const photo = story.photo && loadPhoto( story.photo.src );
		show( drawStoryCard( opened.place, story, photo?.complete ? photo : null, closeHovered ) );
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
		closeHovered = false;

	}

	return { group, setPlaces, update, pick, pickCard, hoverClose, hover, toggle, close };

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

// A story's card: the photo with its credit on the left (if there is one), and on the right the
// title, each part under a colored tag, then the sources. Side by side, so the card stays short
// enough to see whole. Until the photo has loaded, its column holds a placeholder of the same width.
const STORY_TEXT_WIDTH = 1020; // px
const PHOTO_WIDTH = 640; // px
const PHOTO_MAX_HEIGHT = 900; // px; a taller (portrait) photo is narrowed to this
function drawStoryCard( place: Place, story: Story, photo: HTMLImageElement | null, closeHovered: boolean ) {

	const PAD = 40, GAP = 40, TEXT = STORY_TEXT_WIDTH - 36; // room for punctuation that hangs over
	const left = story.photo ? PHOTO_WIDTH + GAP : 0;
	const W = PAD * 2 + left + STORY_TEXT_WIDTH;
	const TITLE = 'bold 54px system-ui, sans-serif', TAG = 'bold 30px system-ui, sans-serif';
	const BODY = '36px system-ui, sans-serif', SOURCE = '25px system-ui, sans-serif';
	const canvas = document.createElement( 'canvas' );
	const ctx = canvas.getContext( '2d' )!;

	// Lay out both columns first, to know the height.
	type Row = { font: string, color: string, text: string, height: number, tag?: string, image?: { img: HTMLImageElement | null, w: number, h: number } };
	const photoRows: Row[] = [];
	if ( story.photo ) {

		const scale = photo ? Math.min( PHOTO_WIDTH / photo.naturalWidth, PHOTO_MAX_HEIGHT / photo.naturalHeight ) : 0;
		const w = photo ? photo.naturalWidth * scale : PHOTO_WIDTH, h = photo ? photo.naturalHeight * scale : PHOTO_WIDTH * 0.75;
		photoRows.push( { font: SOURCE, color: '', text: '', height: h + 14, image: { img: photo, w, h } } );
		const { caption, author, license } = story.photo;
		ctx.font = SOURCE;
		for ( const line of wrap( ctx, caption, PHOTO_WIDTH ) ) photoRows.push( { font: SOURCE, color: '#c8d6e5', text: line, height: 36 } );
		for ( const line of wrap( ctx, `写真: ${ author }（${ license }、Wikimedia Commons）`, PHOTO_WIDTH ) ) photoRows.push( { font: SOURCE, color: '#9fb3c8', text: line, height: 36 } );

	}

	const rows: Row[] = [ { font: TITLE, color: '#ffffff', text: place.name, height: 80 } ];
	rows.push( { font: SOURCE, color: '#9fb3c8', text: `${ place.town }　標高 約 ${ Math.round( place.elevation ) } m`, height: 52 } );
	for ( const s of story.sections ) {

		const { label, color } = STORY_LABELS[ s.kind ];
		rows.push( { font: TAG, color: '#ffffff', text: label, height: 58, tag: color } );
		ctx.font = BODY;
		for ( const line of wrap( ctx, s.text, TEXT ) ) rows.push( { font: BODY, color: '#e5edf5', text: line, height: 50 } );
		rows[ rows.length - 1 ].height += 14;

	}

	rows.push( { font: SOURCE, color: '#9fb3c8', text: '出典', height: 40 } );
	ctx.font = SOURCE;
	for ( const src of story.sources ) for ( const line of wrap( ctx, `・${ src.label }`, TEXT ) ) rows.push( { font: SOURCE, color: '#9fb3c8', text: line, height: 36 } );

	const height = ( rs: Row[] ) => rs.reduce( ( h, r ) => h + r.height, 0 );
	canvas.width = W;
	canvas.height = PAD * 2 + Math.max( height( rows ), height( photoRows ) );
	ctx.fillStyle = 'rgba(20, 26, 36, 0.94)';
	ctx.beginPath();
	ctx.roundRect( 0, 0, W, canvas.height, 28 );
	ctx.fill();
	ctx.fillStyle = STORY_COLOR;
	ctx.fillRect( 0, 24, 12, canvas.height - 48 );

	ctx.textBaseline = 'top';
	const drawColumn = ( rs: Row[], x: number ) => {

		let y = PAD;
		for ( const r of rs ) {

			ctx.font = r.font;
			if ( r.image ) {

				if ( r.image.img ) {

					ctx.drawImage( r.image.img, x, y, r.image.w, r.image.h );

				} else {

					ctx.fillStyle = 'rgba(255, 255, 255, 0.06)';
					ctx.fillRect( x, y, r.image.w, r.image.h );

				}

			} else if ( r.tag ) {

				const w = ctx.measureText( r.text ).width + 28;
				ctx.fillStyle = r.tag;
				ctx.beginPath();
				ctx.roundRect( x, y + 4, w, 44, 10 );
				ctx.fill();
				ctx.fillStyle = r.color;
				ctx.fillText( r.text, x + 14, y + 11 );

			} else {

				ctx.fillStyle = r.color;
				ctx.fillText( r.text, x, y );

			}

			y += r.height;

		}

	};

	drawColumn( photoRows, PAD );
	drawColumn( rows, PAD + left );
	return {
		canvas,
		// Keep the text the same apparent size with or without the photo column.
		layout: { width: W, height: canvas.height, close: drawCloseButton( ctx, W, closeHovered ), widthScale: W / ( PAD * 2 + STORY_TEXT_WIDTH ) },
	};

}

// Where a card's close button is on its canvas (px), for hit-testing the card.
type CardLayout = { width: number, height: number, close: { x: number, y: number, size: number }, widthScale: number };

// A round × button in the card's top right corner, lit while pointed at.
const CLOSE_SIZE = 76; // px
function drawCloseButton( ctx: CanvasRenderingContext2D, width: number, hovered: boolean ) {

	const x = width - 24 - CLOSE_SIZE, y = 24, r = CLOSE_SIZE / 2;
	ctx.fillStyle = hovered ? '#ffffff' : 'rgba(255, 255, 255, 0.16)';
	ctx.beginPath();
	ctx.arc( x + r, y + r, r, 0, Math.PI * 2 );
	ctx.fill();
	ctx.strokeStyle = hovered ? '#141a24' : '#ffffff';
	ctx.lineWidth = 7;
	ctx.lineCap = 'round';
	const a = r * 0.42;
	ctx.beginPath();
	ctx.moveTo( x + r - a, y + r - a );
	ctx.lineTo( x + r + a, y + r + a );
	ctx.moveTo( x + r + a, y + r - a );
	ctx.lineTo( x + r - a, y + r + a );
	ctx.stroke();
	return { x, y, size: CLOSE_SIZE };

}

function drawCard( place: Place, cityName: string, closeHovered: boolean ) {

	const { title, lines, notes } = describePlace( place, cityName );
	const W = 900, PAD = 36;
	const canvas = document.createElement( 'canvas' );
	canvas.width = W;
	canvas.height = PAD * 2 + 76 + lines.length * 52 + ( notes.length ? 16 + notes.length * 40 : 0 );
	const ctx = canvas.getContext( '2d' )!;
	ctx.fillStyle = 'rgba(20, 26, 36, 0.92)';
	ctx.beginPath();
	ctx.roundRect( 0, 0, W, canvas.height, 28 );
	ctx.fill();
	if ( place.kind === 'shelter' ) {

		ctx.fillStyle = SHELTER_COLOR;
		ctx.fillRect( 0, 24, 12, canvas.height - 48 );

	}

	ctx.textBaseline = 'top';
	let y = PAD;
	ctx.fillStyle = '#ffffff';
	ctx.font = 'bold 56px system-ui, sans-serif';
	ctx.fillText( title, PAD, y, W - PAD * 2 - CLOSE_SIZE );
	y += 76;
	ctx.font = '38px system-ui, sans-serif';
	for ( const line of lines ) {

		ctx.fillStyle = '#dbe7f3';
		ctx.fillText( line, PAD, y, W - PAD * 2 );
		y += 52;

	}

	y += 16;
	ctx.font = '30px system-ui, sans-serif';
	for ( const note of notes ) {

		ctx.fillStyle = '#9fb3c8';
		ctx.fillText( note, PAD, y, W - PAD * 2 );
		y += 40;

	}

	return { canvas, layout: { width: W, height: canvas.height, close: drawCloseButton( ctx, W, closeHovered ), widthScale: 1 } };

}
