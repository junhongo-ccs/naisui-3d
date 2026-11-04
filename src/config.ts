// The one city this build shows (municipality code), or null for every city in cities.json with a
// picker. With one city there is nowhere else to wander off to in VR, and no city list to open.
export const ONLY_CITY: string | null = '14204'; // 鎌倉市

// The part of the city to show, per city: [west, south, east, north] in degrees. The ground, the
// flood tiles, the pins and the VR hand map stay within it (plus a margin), and VR can't leave it.
// Cities without one show their whole flood area.
export const AREA: Record<string, [ number, number, number, number ]> = {
	// Central Kamakura: 北鎌倉・円覚寺 to 材木座, 長谷・大仏 to 鎌倉宮.
	'14204': [ 139.530, 35.302, 139.572, 35.342 ],
};

// /plateau's buildings, per city: the LOD2 tileset without textures (the catalog's cities.json has
// the textured one), shown as plain gray models over a map.
export const PLAIN_BUILDINGS: Record<string, string> = {
	'14204': 'https://assets.cms.plateau.reearth.io/assets/0b/89cea0-eaae-40c2-9707-84c01ef3a6c9/14204_kamakura-shi_city_2024_citygml_1_op_bldg_3dtiles_lod2_no_texture/tileset.json',
};

// Where VR starts, per city: a point on a street ([lat, lon], with its elevation in meters above
// the geoid) and a point to face. Take them from the street's centerline (e.g. OpenStreetMap), not
// from a landmark: a place-name point can sit inside a building, and with Google's tiles that puts
// the user inside its walls. Cities without one start where the map view was looking.
export const VR_START: Record<string, { at: [ number, number ], elevation: number, facing: [ number, number ] }> = {
	// 若宮大路 at 小町二丁目, looking up the street to 鶴岡八幡宮.
	'14204': { at: [ 35.32056, 139.55312 ], elevation: 6, facing: [ 35.32366, 139.55502 ] },
};
