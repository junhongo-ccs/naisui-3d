import * as THREE from 'three';

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
};

// src/data/places/<city code>.json, written by scripts/build-places.mjs, and
// src/data/stories/<city code>.json, written by hand.
const files = import.meta.glob<{ landmarks: Place[], shelters: Place[] }>( './data/places/*.json', { import: 'default', eager: true } );
const storyFiles = import.meta.glob<{ stories: ( Omit<Place, 'kind' | 'story'> & Story )[] }>( './data/stories/*.json', { import: 'default', eager: true } );

export function placesFor( code: string ): Place[] {

	const f = files[ `./data/places/${ code }.json` ];
	const stories = ( storyFiles[ `./data/stories/${ code }.json` ]?.stories ?? [] ).map( ( { sections, sources, ...where } ): Place => ( {
		...where, kind: 'story', story: { sections, sources },
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
const STORY_CARD_WIDTH = 0.5; // about 30° tall: fits the PC view (55°) and reads in VR
const PICK_ANGLE = 0.03;
const SHELTER_NAME_RANGE = 2500; // m; farther shelters show the icon only
const NAME_SCALE = 0.8; // shelter name height / icon height

// Pins over a city: landmark names, so the user can tell where they are, and shelters. Each pin is
// a stem standing on the ground with a label on top, kept the same apparent size at any distance
// and drawn over the scene, so a landmark behind a hill still shows which way it is.
// Pointing at a pin and clicking (or pulling the trigger in VR) opens a card describing it.
export function createPins() {

	const group = new THREE.Group();
	const card = new THREE.Sprite( new THREE.SpriteMaterial( { depthTest: false, transparent: true } ) );
	card.center.set( 0.5, - 0.08 );
	card.renderOrder = 1002;
	card.visible = false;
	group.add( card );

	type Pin = {
		place: Place,
		base: THREE.Vector3,
		head: THREE.Vector3,
		stem: THREE.Line,
		icon: THREE.Sprite,
		name: THREE.Sprite | null, // shelters and stories: the name next to the icon
	};
	let pins: Pin[] = [];
	let hovered: Pin | null = null;
	let opened: Pin | null = null;
	let cityName = '';
	const stemMaterial = new THREE.LineBasicMaterial( { color: '#ffffff', transparent: true, opacity: 0.85, depthTest: false } );

	function sprite( canvas: HTMLCanvasElement, centerX: number ) {

		const texture = new THREE.CanvasTexture( canvas );
		texture.colorSpace = THREE.SRGBColorSpace;
		const s = new THREE.Sprite( new THREE.SpriteMaterial( { map: texture, depthTest: false, transparent: true } ) );
		s.center.set( centerX, 0 );
		s.renderOrder = 1001;
		s.userData.aspect = canvas.width / canvas.height;
		return s;

	}

	// `places` in `city`, positioned by `toLocal` (lat, lon, height above the geoid → scene meters).
	function setPlaces( city: string, places: Place[], toLocal: ( lat: number, lon: number, elevation: number ) => THREE.Vector3 ) {

		cityName = city;
		for ( const p of pins ) {

			for ( const s of [ p.icon, p.name ] ) {

				s?.material.map?.dispose();
				s?.material.dispose();

			}

			p.stem.geometry.dispose();
			group.remove( p.stem, p.icon, ...( p.name ? [ p.name ] : [] ) );

		}

		hovered = opened = null;
		card.visible = false;
		pins = places.map( place => {

			const base = toLocal( place.lat, place.lon, place.elevation );
			const stem = new THREE.Line(
				new THREE.BufferGeometry().setFromPoints( [ new THREE.Vector3(), new THREE.Vector3( 0, 1, 0 ) ] ),
				stemMaterial,
			);
			stem.position.copy( base );
			stem.renderOrder = 1001;
			const color = place.kind === 'shelter' ? SHELTER_COLOR : STORY_COLOR;
			const icon = sprite( place.kind === 'landmark' ? textLabel( place.name, LANDMARK_BG ) : place.kind === 'shelter' ? shelterIcon() : storyIcon(), 0.5 );
			const name = place.kind === 'landmark' ? null : sprite( textLabel( place.kind === 'story' ? `解説: ${ place.name }` : place.name, color ), 0 );
			// To the right of the round icon (as wide as it is tall), centered on it vertically.
			// Sprite centers are fractions of the sprite's own size.
			name?.center.set( - 0.55 / ( NAME_SCALE * name.userData.aspect ), - ( 1 - NAME_SCALE ) / 2 / NAME_SCALE );
			group.add( stem, icon, ...( name ? [ name ] : [] ) );
			return { place, base, head: base.clone(), stem, icon, name };

		} );

	}

	// Resize the pins for the eye's distance. Call every frame before rendering.
	function update( eye: THREE.Vector3 ) {

		for ( const p of pins ) {

			const d = eye.distanceTo( p.base );
			const h = Math.max( d * LABEL_SIZE, 0.05 ) * ( p === hovered ? 1.3 : 1 );
			const stemHeight = THREE.MathUtils.clamp( d * 0.05, 3, 400 );
			p.stem.scale.y = stemHeight;
			p.head.copy( p.base ).setY( p.base.y + stemHeight );
			p.icon.position.copy( p.head );
			p.icon.scale.set( h * p.icon.userData.aspect, h, 1 );
			if ( p.name ) {

				p.name.visible = p.place.kind === 'story' || d < SHELTER_NAME_RANGE || p === hovered || p === opened;
				p.name.position.copy( p.head );
				p.name.scale.set( h * NAME_SCALE * p.name.userData.aspect, h * NAME_SCALE, 1 );

			}

		}

		if ( opened ) {

			// A story's card is tall, so it is centered on the pin's label (about eye level) rather
			// than above it, where it would mean looking far up.
			const d = eye.distanceTo( opened.head );
			const w = d * ( opened.place.kind === 'story' ? STORY_CARD_WIDTH : CARD_WIDTH );
			card.center.set( 0.5, opened.place.kind === 'story' ? 0.5 : - 0.08 );
			card.position.copy( opened.head ).setY( opened.head.y + d * LABEL_SIZE * 1.4 );
			card.scale.set( w, w / card.userData.aspect, 1 );

		}

	}

	// The pin a ray points at (within a small angle of its label), nearest first.
	const toHead = new THREE.Vector3();
	function pick( ray: THREE.Ray ): { place: Place, distance: number } | null {

		let best: Pin | null = null, bestAngle = PICK_ANGLE, bestDistance = Infinity;
		for ( const p of pins ) {

			// Aim at the middle of the label, not its bottom edge.
			toHead.copy( p.head ).setY( p.head.y + p.icon.scale.y / 2 ).sub( ray.origin );
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

	function hover( place: Place | null ) {

		hovered = pins.find( p => p.place === place ) ?? null;

	}

	// Open the card for a place, or close it if it is already open.
	function toggle( place: Place ) {

		const pin = pins.find( p => p.place === place ) ?? null;
		opened = opened === pin ? null : pin;
		card.visible = !! opened;
		if ( opened ) ( opened.place.story ? drawStoryCard( card, opened.place, opened.place.story ) : drawCard( card, opened.place, cityName ) );

	}

	function close() {

		opened = null;
		card.visible = false;

	}

	return { group, setPlaces, update, pick, hover, toggle, close };

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

// A story's card: title, then each part under a colored tag, then the sources.
function drawStoryCard( card: THREE.Sprite, place: Place, story: Story ) {

	const W = 1100, PAD = 40, TEXT = W - PAD * 2 - 36; // room for punctuation that hangs over
	const TITLE = 'bold 54px system-ui, sans-serif', TAG = 'bold 30px system-ui, sans-serif';
	const BODY = '36px system-ui, sans-serif', SOURCE = '25px system-ui, sans-serif';
	const canvas = document.createElement( 'canvas' );
	const ctx = canvas.getContext( '2d' )!;

	// Lay out first, to know the height.
	type Row = { font: string, color: string, text: string, height: number, tag?: string };
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

	canvas.width = W;
	canvas.height = PAD * 2 + rows.reduce( ( h, r ) => h + r.height, 0 );
	ctx.fillStyle = 'rgba(20, 26, 36, 0.94)';
	ctx.beginPath();
	ctx.roundRect( 0, 0, W, canvas.height, 28 );
	ctx.fill();
	ctx.fillStyle = STORY_COLOR;
	ctx.fillRect( 0, 24, 12, canvas.height - 48 );

	ctx.textBaseline = 'top';
	let y = PAD;
	for ( const r of rows ) {

		ctx.font = r.font;
		if ( r.tag ) {

			const w = ctx.measureText( r.text ).width + 28;
			ctx.fillStyle = r.tag;
			ctx.beginPath();
			ctx.roundRect( PAD, y + 4, w, 44, 10 );
			ctx.fill();
			ctx.fillStyle = r.color;
			ctx.fillText( r.text, PAD + 14, y + 11 );

		} else {

			ctx.fillStyle = r.color;
			ctx.fillText( r.text, PAD, y );

		}

		y += r.height;

	}

	setCardTexture( card, canvas );

}

function setCardTexture( card: THREE.Sprite, canvas: HTMLCanvasElement ) {

	const mat = card.material;
	mat.map?.dispose();
	mat.map = new THREE.CanvasTexture( canvas );
	mat.map.colorSpace = THREE.SRGBColorSpace;
	mat.needsUpdate = true;
	card.userData.aspect = canvas.width / canvas.height;

}

function drawCard( card: THREE.Sprite, place: Place, cityName: string ) {

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
	ctx.fillText( title, PAD, y, W - PAD * 2 );
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

	setCardTexture( card, canvas );

}
