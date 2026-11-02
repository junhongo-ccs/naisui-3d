import { describePlace, STORY_COLOR, SHELTER_COLOR, STORY_LABELS, type Place } from './places';

// A place's description on a phone: a modal over the view, in place of the card in the scene that
// a PC or headset shows. It says the same, with the sources as links. Closed with its × button, a
// tap outside it, or the back key; it stays put (no dragging, unlike the card in the scene).
export function createPlaceDialog( onClose: () => void ) {

	const dialog = document.createElement( 'dialog' );
	dialog.id = 'place-dialog';
	document.body.append( dialog );
	dialog.addEventListener( 'close', onClose );
	// A tap on the backdrop lands on the dialog itself; one on its contents, on them.
	dialog.addEventListener( 'click', e => {

		if ( e.target === dialog ) dialog.close();

	} );

	// Show `body` under a title and the × button, with a stripe of `color` down the left side.
	function show( titleText: string, color: string, body: HTMLElement ) {

		const head = el( 'header', 'dialog-head' );
		const title = el( 'h2', '', titleText );
		title.id = 'place-dialog-title';
		const close = el( 'button', 'dialog-close', '×' );
		close.type = 'button';
		close.setAttribute( 'aria-label', '閉じる' );
		close.addEventListener( 'click', () => dialog.close() );
		head.append( title, close );
		dialog.setAttribute( 'aria-labelledby', title.id );
		dialog.style.setProperty( '--kind-color', color );
		dialog.replaceChildren( head, body );
		if ( ! dialog.open ) dialog.showModal();
		body.scrollTop = 0;
		// Not the × button: a focus ring on it as the dialog opens looks like a selection.
		close.blur();

	}

	function open( place: Place, cityName: string ) {

		const body = el( 'div', 'dialog-body' );
		const story = place.story;
		if ( story ) {

			body.append( el( 'p', 'dialog-where', `${ place.town }　標高 約 ${ Math.round( place.elevation ) } m` ) );
			// The photo and the text: side by side when held sideways (style.css), else stacked.
			const columns = el( 'div', 'dialog-columns' );
			const text = el( 'div', 'dialog-text' );
			if ( story.photo ) {

				const { src, caption, author, license, url } = story.photo;
				const fig = el( 'figure', 'dialog-photo' );
				const img = document.createElement( 'img' );
				img.src = import.meta.env.BASE_URL + src;
				img.alt = caption;
				const credit = el( 'figcaption', '', `${ caption }　` );
				credit.append( link( `写真: ${ author }（${ license }、Wikimedia Commons）`, url ) );
				fig.append( img, credit );
				columns.append( fig );

			}

			for ( const s of story.sections ) {

				const { label, color, text: ink } = STORY_LABELS[ s.kind ];
				const tag = el( 'span', 'dialog-tag', label );
				tag.style.background = color;
				tag.style.color = ink;
				text.append( tag, el( 'p', '', s.text ) );

			}

			const sources = el( 'ul', 'dialog-sources' );
			for ( const src of story.sources ) {

				const li = el( 'li' );
				li.append( link( src.label, src.url ) );
				sources.append( li );

			}

			text.append( el( 'h3', '', '出典' ), sources );
			columns.append( text );
			body.append( columns );

			show( place.name, STORY_COLOR, body );

		} else {

			const { lines, notes } = describePlace( place, cityName );
			for ( const line of lines.filter( Boolean ) ) body.append( el( 'p', 'dialog-line', line ) );
			if ( notes.length ) {

				const ul = el( 'ul', 'dialog-notes' );
				for ( const note of notes ) ul.append( el( 'li', '', note ) );
				body.append( ul );

			}

			show( place.name, place.kind === 'shelter' ? SHELTER_COLOR : 'transparent', body );

		}

	}

	// A list of places to choose from (pins too close together to tell apart on screen even up
	// close); `choose` is called with the one tapped.
	function openList( places: readonly Place[], choose: ( place: Place ) => void ) {

		const body = el( 'div', 'dialog-body' );
		const list = el( 'ul', 'dialog-list' );
		const order = { story: 0, shelter: 1, landmark: 2 };
		for ( const place of [ ...places ].sort( ( a, b ) => order[ a.kind ] - order[ b.kind ] ) ) {

			const item = el( 'button', `dialog-item pin-${ place.kind }` );
			item.type = 'button';
			const icon = el( 'span', 'pin-icon' );
			icon.setAttribute( 'aria-hidden', 'true' );
			item.append( icon, el( 'span', '', place.kind === 'story' ? `解説: ${ place.name }` : place.name ) );
			item.addEventListener( 'click', () => choose( place ) );
			const li = el( 'li' );
			li.append( item );
			list.append( li );

		}

		body.append( list );
		show( 'この近くの場所', 'transparent', body );

	}

	return { open, openList, get isOpen() { return dialog.open; } };

}

function el<K extends keyof HTMLElementTagNameMap>( tag: K, className = '', text = '' ) {

	const e = document.createElement( tag );
	if ( className ) e.className = className;
	if ( text ) e.textContent = text;
	return e;

}

function link( text: string, url: string ) {

	const a = el( 'a', '', text );
	a.href = url;
	a.target = '_blank';
	a.rel = 'noopener';
	return a;

}
