// One-shot migration from the 1795 baseline to a 1680 baseline.
//
// What it does:
//   1. Rewrites provinces.geojson — every feature gets a new 'owner'
//      computed from (modern_country, province_name) using a curated
//      1680 mapping. Reference: https://www.oldmapsonline.org/en/history/regions?year=1680
//   2. Writes a fresh owners.json + palette.json for the 1680 country set.
//   3. Empties seed_forces.json and deletes every public/data/forces/*.json
//      (the bake script writes only nations with forces; nothing to keep).
//   4. Re-runs scripts/bake-state.mjs to regenerate state.json + force files.
//
// Run once with: node scripts/migrate-to-1680.mjs
//
// SCHEMA_VERSION bumping (theatrum/v7 → v8) and perm.json re-assignments
// are handled separately so this file stays focused on the world map.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA = path.join(ROOT, 'public/data');
const GEOJSON = path.join(DATA, 'provinces.geojson');
const OWNERS = path.join(DATA, 'owners.json');
const PALETTE = path.join(DATA, 'palette.json');
const SEED_FORCES = path.join(DATA, 'seed_forces.json');
const FORCES_DIR = path.join(DATA, 'forces');

// ----------------------------------------------------------------------
// 1680 country palette (Title Case names; lowercased at bake time).
// Colors lifted from the existing palette where the country survives;
// new entries get distinct hues that don't clash with neighbors.
// ----------------------------------------------------------------------
const PALETTE_1680 = {
  // Western European powers + their colonies
  France: '#1F4E9C',
  Spain: '#E48E1B',
  Portugal: '#046A38',
  Britain: '#D7837F',
  Netherlands: '#FF8C42',
  Sweden: '#034e7c',
  Denmark: '#C8102E',

  // Eastern Europe
  'Poland-Lithuania': '#ff49c5',
  Russia: '#1B5E20',
  Austria: '#FCD840',
  'Brandenburg-Prussia': '#3C3C3C',
  'HRE Minor States': '#9CB4D6',

  // Italian states
  Savoy: '#7C2128',
  Venice: '#5A1F1F',
  Genoa: '#9F2D2D',
  'Papal States': '#F0F0E8',
  Tuscany: '#C0A050',
  'Knights of Malta': '#E8E8E8',
  Ragusa: '#8B6F47',
  'San Marino': '#5C7CFA',

  Switzerland: '#DA291C',

  // Ottoman world (vassals as separate entries — gameplay-relevant)
  'Ottoman Empire': '#ff1c01',
  Wallachia: '#73fdff',
  Moldavia: '#ff9300',
  Transylvania: '#5e8b48',

  // South & Central Asia
  'Mughal Empire': '#1098DC',
  'Maratha Confederacy': '#F47216',
  Mysore: '#3F8E5F',
  Persia: '#9B2335',
  Bukhara: '#5F9EA0',
  Khiva: '#40826D',
  'Kazakh Khanates': '#D2691E',
  Nepal: '#DC143C',
  Bhutan: '#FFB300',
  Tibet: '#b59797',
  Maldives: '#0CC0DF',

  // East & Southeast Asia
  China: '#E8A317',
  Korea: '#F0F0E8',
  Japan: '#BC002D',
  Siam: '#A91101',
  Burma: '#DAA520',
  Vietnam: '#E5B72A',
  Cambodia: '#4FB4A3',
  Laos: '#B89D6B',
  'Malay Sultanates': '#F4D03F',
  Brunei: '#B8860B',
  Aceh: '#008055',

  // Arabian peninsula
  Oman: '#8B0000',
  Yemen: '#800000',

  // Africa
  Morocco: '#C1272D',
  Ethiopia: '#722F37',
  'Funj Sultanate': '#A0856B',
  Kongo: '#704214',
  Bornu: '#CD7F32',
  'Hausa City-States': '#01796F',
  Oyo: '#7B2D8E',
  Dahomey: '#3F4DBF',
  Asante: '#FFC107',

  Unclaimed: '#A0A0A0',
  'Contested Territories': '#ffffff',
};

// ----------------------------------------------------------------------
// Default modern_country → 1680 owner (Title Case, must be a key in
// PALETTE_1680). About 90% of provinces hit this table directly; the
// rest go through OVERRIDES below.
// ----------------------------------------------------------------------
const DEFAULT_OWNER = {
  // -------- Europe (whole-country defaults) --------
  France: 'France',
  Monaco: 'France',
  Spain: 'Spain',
  Gibraltar: 'Spain', // British 1713; Spanish in 1680
  Andorra: 'Spain', // joint sovereignty France/Bp of Urgell — pragmatic
  Portugal: 'Portugal',
  'United Kingdom': 'Britain',
  Ireland: 'Britain', // under English rule in 1680
  'Isle of Man': 'Britain',
  Jersey: 'Britain',
  Guernsey: 'Britain',
  Netherlands: 'Netherlands',
  Belgium: 'Spain', // Spanish Netherlands
  Luxembourg: 'Spain', // Spanish Luxembourg (France took 1684)
  Sweden: 'Sweden',
  Finland: 'Sweden', // Swedish Finland
  Estonia: 'Sweden', // Swedish Estonia
  Latvia: 'Sweden', // Swedish Livonia
  Aland: 'Sweden',
  Norway: 'Denmark', // Denmark-Norway union
  Iceland: 'Denmark',
  Greenland: 'Denmark',
  'Faroe Islands': 'Denmark',
  Lithuania: 'Poland-Lithuania',
  Belarus: 'Poland-Lithuania',
  Poland: 'Poland-Lithuania',
  Russia: 'Russia', // overridden below for Kaliningrad, Crimea, Sevastopol
  Austria: 'Austria',
  'Czech Republic': 'Austria', // Bohemia, Moravia
  Slovakia: 'Austria', // Royal Hungary
  Slovenia: 'Austria', // Inner Austria
  Croatia: 'Austria', // Croatia-Slavonia under Habsburg
  Switzerland: 'Switzerland',
  Liechtenstein: 'HRE Minor States',
  Germany: 'HRE Minor States', // overridden below for Brandenburg, Berlin, etc.
  Hungary: 'Ottoman Empire', // overridden below for western Royal Hungary counties
  Romania: 'Transylvania', // overridden below per region
  Moldova: 'Moldavia',
  Bulgaria: 'Ottoman Empire',
  'Republic of Serbia': 'Ottoman Empire',
  Kosovo: 'Ottoman Empire',
  'Bosnia and Herzegovina': 'Ottoman Empire',
  Albania: 'Ottoman Empire',
  Macedonia: 'Ottoman Empire',
  Greece: 'Ottoman Empire',
  Montenegro: 'Ottoman Empire',
  Cyprus: 'Ottoman Empire', // Ottoman since 1571
  'Northern Cyprus': 'Ottoman Empire',
  Malta: 'Knights of Malta',
  Vatican: 'Papal States',
  'San Marino': 'San Marino',
  Italy: 'HRE Minor States', // placeholder; fully overridden per province below
  Ukraine: 'Poland-Lithuania', // overridden per oblast below

  // -------- Middle East --------
  Turkey: 'Ottoman Empire',
  Syria: 'Ottoman Empire',
  Lebanon: 'Ottoman Empire',
  Israel: 'Ottoman Empire',
  'West Bank': 'Ottoman Empire',
  'Gaza Strip': 'Ottoman Empire',
  Jordan: 'Ottoman Empire',
  Iraq: 'Ottoman Empire',
  'Saudi Arabia': 'Ottoman Empire', // Ottoman Hejaz dominant; rest local emirates
  Yemen: 'Yemen',
  Oman: 'Oman',
  'United Arab Emirates': 'Oman',
  Qatar: 'Oman',
  Bahrain: 'Persia', // Safavid since 1602
  Kuwait: 'Unclaimed', // not yet a town
  Iran: 'Persia',
  Armenia: 'Persia', // Safavid Eastern Armenia; western was Ottoman
  Azerbaijan: 'Persia',
  Georgia: 'Persia', // Kartli/Kakheti as Safavid vassal kingdoms

  // -------- Central / South Asia --------
  Afghanistan: 'Persia', // overridden below per province
  Pakistan: 'Mughal Empire',
  India: 'Mughal Empire', // overridden below per state
  Bangladesh: 'Mughal Empire',
  'Sri Lanka': 'Netherlands', // Dutch Ceylon from 1658
  Nepal: 'Nepal',
  Bhutan: 'Bhutan',
  Maldives: 'Maldives',
  Kazakhstan: 'Kazakh Khanates',
  Uzbekistan: 'Bukhara',
  Turkmenistan: 'Khiva',
  Tajikistan: 'Bukhara',
  Kyrgyzstan: 'Kazakh Khanates',

  // -------- East / Southeast Asia --------
  China: 'China', // overridden for Xizang (Tibet), Xinjiang
  Mongolia: 'China', // Inner Mongolia Qing 1635; Khalkha submitted 1691
  Taiwan: 'China', // Kingdom of Tungning until 1683; pragmatic
  'Hong Kong S.A.R.': 'China',
  'Macau S.A.R': 'Portugal',
  'North Korea': 'Korea',
  'South Korea': 'Korea',
  Japan: 'Japan',
  Myanmar: 'Burma',
  Thailand: 'Siam',
  Cambodia: 'Cambodia',
  Laos: 'Laos',
  Vietnam: 'Vietnam',
  Malaysia: 'Malay Sultanates',
  Singapore: 'Malay Sultanates',
  Brunei: 'Brunei',
  Indonesia: 'Netherlands', // overridden below for Aceh
  'East Timor': 'Portugal',
  Philippines: 'Spain',
  'Spratly Is.': 'Unclaimed',
  'Paracel Islands': 'Unclaimed',

  // -------- North Africa --------
  Morocco: 'Morocco',
  'Western Sahara': 'Morocco',
  Algeria: 'Ottoman Empire', // Regency of Algiers
  Tunisia: 'Ottoman Empire',
  Libya: 'Ottoman Empire',
  Egypt: 'Ottoman Empire',
  Sudan: 'Funj Sultanate',
  'S. Sudan': 'Funj Sultanate',
  Eritrea: 'Ethiopia', // Ottoman held Massawa coast — pragmatic Ethiopia
  Ethiopia: 'Ethiopia',
  Djibouti: 'Unclaimed',
  Somalia: 'Unclaimed',
  Somaliland: 'Unclaimed',

  // -------- West Africa --------
  Mauritania: 'Unclaimed',
  Mali: 'Unclaimed',
  Senegal: 'Unclaimed',
  Gambia: 'Unclaimed',
  'Guinea Bissau': 'Portugal',
  'Cape Verde': 'Portugal',
  Guinea: 'Unclaimed',
  'Sierra Leone': 'Unclaimed',
  Liberia: 'Unclaimed',
  'Ivory Coast': 'Unclaimed',
  Ghana: 'Asante', // Asante consolidating ~1670s
  'Burkina Faso': 'Unclaimed',
  Togo: 'Dahomey',
  Benin: 'Dahomey',
  Nigeria: 'Oyo', // overridden below by region
  Niger: 'Bornu',
  Chad: 'Bornu',
  Cameroon: 'Unclaimed',
  'Sao Tome and Principe': 'Portugal',
  'Equatorial Guinea': 'Unclaimed',
  Gabon: 'Unclaimed',

  // -------- Central / Southern Africa --------
  'Republic of the Congo': 'Kongo',
  'Democratic Republic of the Congo': 'Kongo',
  Angola: 'Portugal', // Portuguese Luanda + coast
  Namibia: 'Unclaimed',
  Botswana: 'Unclaimed',
  'South Africa': 'Unclaimed', // overridden below for Western/Northern Cape
  Lesotho: 'Unclaimed',
  Swaziland: 'Unclaimed',
  Zimbabwe: 'Unclaimed',
  Mozambique: 'Portugal', // Portuguese coastal trading posts
  Zambia: 'Unclaimed',
  Malawi: 'Unclaimed',
  Tanzania: 'Unclaimed',
  Kenya: 'Unclaimed',
  Uganda: 'Unclaimed',
  Rwanda: 'Unclaimed',
  Burundi: 'Unclaimed',
  'United Republic of Tanzania': 'Unclaimed',
  'Central African Republic': 'Unclaimed',
  Madagascar: 'Unclaimed',
  Comoros: 'Unclaimed',
  Mauritius: 'Netherlands', // Dutch held 1638–1710
  Seychelles: 'Unclaimed',

  // -------- Americas (European colonial frame) --------
  Canada: 'France', // overridden per province below
  'United States of America': 'Britain', // overridden per state below
  'Saint Pierre and Miquelon': 'France',
  Mexico: 'Spain',
  Belize: 'Britain', // British logwood camps from 1638
  Guatemala: 'Spain',
  'El Salvador': 'Spain',
  Honduras: 'Spain',
  Nicaragua: 'Spain',
  'Costa Rica': 'Spain',
  Panama: 'Spain',
  Cuba: 'Spain',
  'The Bahamas': 'Britain', // British proprietary colony 1670
  Jamaica: 'Britain', // English since 1655
  Haiti: 'France', // Saint-Domingue from 1659
  'Dominican Republic': 'Spain',
  'Puerto Rico': 'Spain',
  'US Naval Base Guantanamo Bay': 'Spain',
  'Cayman Islands': 'Britain',
  'Turks and Caicos Islands': 'Britain',
  'British Virgin Islands': 'Britain',
  'United States Virgin Islands': 'Denmark', // Danish West Indies (St Thomas 1672)
  Anguilla: 'Britain',
  Antigua: 'Britain',
  'Antigua and Barbuda': 'Britain',
  Aruba: 'Netherlands',
  Barbados: 'Britain',
  'Caribbean Netherlands': 'Netherlands',
  Curaçao: 'Netherlands',
  Dominica: 'Unclaimed', // contested Carib island in 1680
  Grenada: 'France', // French from 1649
  Guadeloupe: 'France',
  Martinique: 'France',
  Montserrat: 'Britain',
  'Saint Barthelemy': 'France',
  'Saint Helena': 'Britain', // English East India Co colony from 1659
  'Saint Kitts and Nevis': 'Britain',
  'Saint Lucia': 'France',
  'Saint Martin': 'France',
  'Saint Vincent and the Grenadines': 'Unclaimed',
  'Sint Maarten': 'Netherlands',
  'Trinidad and Tobago': 'Spain',
  'Falkland Islands': 'Unclaimed',
  Bermuda: 'Britain',
  Venezuela: 'Spain',
  Colombia: 'Spain',
  Ecuador: 'Spain',
  Peru: 'Spain',
  Bolivia: 'Spain',
  Chile: 'Spain',
  Argentina: 'Spain',
  Uruguay: 'Spain', // Colonia del Sacramento contested with Portugal
  Paraguay: 'Spain',
  Brazil: 'Portugal',
  Guyana: 'Netherlands', // Dutch Essequibo/Demerara/Berbice
  Suriname: 'Netherlands', // since 1667
  'French Polynesia': 'Unclaimed',
  'New Caledonia': 'Unclaimed',
    'Clipperton Island': 'Unclaimed',

  // -------- Pacific / Oceania --------
  Australia: 'Unclaimed',
  'New Zealand': 'Unclaimed',
  Fiji: 'Unclaimed',
  Vanuatu: 'Unclaimed',
  'Solomon Islands': 'Unclaimed',
  'Papua New Guinea': 'Unclaimed',
  'Federated States of Micronesia': 'Spain', // Spanish Marianas/Carolines
  Guam: 'Spain',
  'Northern Mariana Islands': 'Spain',
  'Marshall Islands': 'Spain',
  Palau: 'Spain',
  Kiribati: 'Unclaimed',
  Tuvalu: 'Unclaimed',
  Nauru: 'Unclaimed',
  Samoa: 'Unclaimed',
  'American Samoa': 'Unclaimed',
  Tonga: 'Unclaimed',
  'Cook Islands': 'Unclaimed',
  Niue: 'Unclaimed',
  'Wallis and Futuna': 'Unclaimed',
  'Pitcairn Islands': 'Unclaimed',
  'Norfolk Island': 'Unclaimed',
  'Heard Island and McDonald Islands': 'Unclaimed',
  Antarctica: 'Unclaimed',
  'South Georgia and the Islands': 'Unclaimed',
  'British Indian Ocean Territory': 'Unclaimed',
  'Indian Ocean Territories': 'Unclaimed',
  'Coral Sea Islands': 'Unclaimed',
  'Ashmore and Cartier Islands': 'Unclaimed',
  'Lord Howe Island': 'Unclaimed',
  'Macquarie Island': 'Unclaimed',
  'Jervis Bay Territory': 'Unclaimed',
  'Australian Capital Territory': 'Unclaimed',
  'French Southern and Antarctic Lands': 'Unclaimed',
  'United States Minor Outlying Islands': 'Unclaimed',
  'Baykonur Cosmodrome': 'Russia',
  'Siachen Glacier': 'Mughal Empire',
  'Akrotiri Sovereign Base Area': 'Ottoman Empire',
  'Dhekelia Sovereign Base Area': 'Ottoman Empire',
};

// ----------------------------------------------------------------------
// Per-province overrides for modern countries that straddle multiple
// 1680 powers (Germany, Italy, USA, Canada, India, Indonesia, China,
// Romania, Hungary, Russia, France, Ukraine, Saudi Arabia, Afghanistan,
// Nigeria, South Africa).
// ----------------------------------------------------------------------
const OVERRIDES = {
  Germany: {
    Brandenburg: 'Brandenburg-Prussia',
    Berlin: 'Brandenburg-Prussia',
    'Mecklenburg-Vorpommern': 'Sweden', // Swedish Pomerania
    Bremen: 'Sweden', // Bremen-Verden Swedish duchy 1648–1719
    'Schleswig-Holstein': 'Denmark',
    // Niedersachsen, Bayern, Sachsen etc. → HRE Minor States (default)
  },

  Italy: {
    // North-west: Savoy + Genoa
    'Aoste': 'Savoy',
    Turin: 'Savoy',
    Cuneo: 'Savoy',
    Asti: 'Savoy',
    Alessandria: 'Savoy',
    Biella: 'Savoy',
    Vercelli: 'Savoy',
    Novara: 'Savoy',
    'Verbano-Cusio-Ossola': 'Savoy',
    Genova: 'Genoa',
    Imperia: 'Genoa',
    'La Spezia': 'Genoa',
    Savona: 'Genoa',
    // Spanish Milan
    Bergamo: 'Spain',
    Brescia: 'Spain',
    Como: 'Spain',
    Cremona: 'Spain',
    Lecco: 'Spain',
    Lodi: 'Spain',
    Mantova: 'Spain', // Duchy of Mantua technically; pragmatic
    Milano: 'Spain',
    'Monza e Brianza': 'Spain',
    Pavia: 'Spain',
    Sondrio: 'Spain',
    Varese: 'Spain',
    // Habsburg Tyrol & coastal county
    Bozen: 'Austria',
    Trento: 'Austria',
    Gorizia: 'Austria',
    Trieste: 'Austria',
    // Venice
    Belluno: 'Venice',
    Padova: 'Venice',
    Rovigo: 'Venice',
    Treviso: 'Venice',
    Venezia: 'Venice',
    Verona: 'Venice',
    Vicenza: 'Venice',
    Pordenone: 'Venice',
    Udine: 'Venice',
    // Papal States (Romagna + Marche + Umbria + Lazio)
    Bologna: 'Papal States',
    Ferrara: 'Papal States',
    'Forlì-Cesena': 'Papal States',
    Ravenna: 'Papal States',
    Rimini: 'Papal States',
    Ancona: 'Papal States',
    'Ascoli Piceno': 'Papal States',
    Fermo: 'Papal States',
    Macerata: 'Papal States',
    'Pesaro e Urbino': 'Papal States',
    Perugia: 'Papal States',
    Terni: 'Papal States',
    Frosinone: 'Papal States',
    Latina: 'Papal States',
    Rieti: 'Papal States',
    Roma: 'Papal States',
    Viterbo: 'Papal States',
    // HRE-aligned duchies (Modena/Reggio Este, Parma Farnese)
    Modena: 'HRE Minor States',
    'Reggio Emilia': 'HRE Minor States',
    Parma: 'HRE Minor States',
    Piacenza: 'HRE Minor States',
    // Tuscany
    Arezzo: 'Tuscany',
    Firenze: 'Tuscany',
    Grosseto: 'Tuscany',
    Livorno: 'Tuscany',
    Lucca: 'Tuscany', // Republic of Lucca, pragmatic
    'Massa-Carrara': 'Tuscany',
    Pisa: 'Tuscany',
    Pistoia: 'Tuscany',
    Prato: 'Tuscany',
    Siena: 'Tuscany',
    // Spanish Naples (Abruzzo, Molise, Campania, Apulia, Basilicata, Calabria)
    Chieti: 'Spain',
    "L'Aquila": 'Spain',
    Pescara: 'Spain',
    Teramo: 'Spain',
    Campobasso: 'Spain',
    Isernia: 'Spain',
    Avellino: 'Spain',
    Benevento: 'Spain',
    Caserta: 'Spain',
    Napoli: 'Spain',
    Salerno: 'Spain',
    Bari: 'Spain',
    'Barletta-Andria Trani': 'Spain',
    Brindisi: 'Spain',
    Foggia: 'Spain',
    Lecce: 'Spain',
    Taranto: 'Spain',
    Matera: 'Spain',
    Potenza: 'Spain',
    Catanzaro: 'Spain',
    Cosenza: 'Spain',
    Crotene: 'Spain',
    'Reggio Calabria': 'Spain',
    'Vibo Valentia': 'Spain',
    // Spanish Sicily
    Agrigento: 'Spain',
    Caltanissetta: 'Spain',
    Catania: 'Spain',
    Enna: 'Spain',
    Messina: 'Spain',
    Palermo: 'Spain',
    Ragusa: 'Spain',
    Siracusa: 'Spain',
    Trapani: 'Spain',
    // Spanish Sardinia
    Cagliari: 'Spain',
    'Carbonia-Iglesias': 'Spain',
    'Medio Campidano': 'Spain',
    Nuoro: 'Spain',
    Ogliastra: 'Spain',
    'Olbia-Tempio': 'Spain',
    Oristrano: 'Spain',
    Sassari: 'Spain',
  },

  'United States of America': {
    // British colonies on the seaboard (chartered by 1680)
    Massachusetts: 'Britain',
    'New Hampshire': 'Britain',
    'Rhode Island': 'Britain',
    Connecticut: 'Britain',
    'New York': 'Britain', // taken from Dutch 1664
    'New Jersey': 'Britain',
    Pennsylvania: 'Britain', // chartered 1681 — close enough
    Delaware: 'Britain',
    Maryland: 'Britain',
    Virginia: 'Britain',
    'West Virginia': 'Britain', // part of Virginia
    'North Carolina': 'Britain',
    'South Carolina': 'Britain', // founded 1670
    Maine: 'Britain', // under Massachusetts
    Vermont: 'Britain', // contested NY/NH, pragmatic
    'District of Columbia': 'Britain',
    // Spanish frontier
    Florida: 'Spain',
    Texas: 'Spain',
    'New Mexico': 'Spain',
    Arizona: 'Spain',
    California: 'Spain',
    // Native / unclaimed interior
    Georgia: 'Unclaimed', // not founded until 1732
    Alabama: 'Unclaimed',
    Mississippi: 'Unclaimed',
    Louisiana: 'Unclaimed', // La Salle's claim was 1682
    Tennessee: 'Unclaimed',
    Kentucky: 'Unclaimed',
    Ohio: 'Unclaimed',
    Indiana: 'Unclaimed',
    Illinois: 'Unclaimed',
    Michigan: 'Unclaimed',
    Wisconsin: 'Unclaimed',
    Minnesota: 'Unclaimed',
    Iowa: 'Unclaimed',
    Missouri: 'Unclaimed',
    Arkansas: 'Unclaimed',
    Oklahoma: 'Unclaimed',
    Kansas: 'Unclaimed',
    Nebraska: 'Unclaimed',
    'South Dakota': 'Unclaimed',
    'North Dakota': 'Unclaimed',
    Montana: 'Unclaimed',
    Wyoming: 'Unclaimed',
    Colorado: 'Unclaimed',
    Utah: 'Unclaimed',
    Nevada: 'Unclaimed',
    Idaho: 'Unclaimed',
    Oregon: 'Unclaimed',
    Washington: 'Unclaimed',
    Alaska: 'Unclaimed', // Russian only from 1741
    Hawaii: 'Unclaimed', // discovered 1778
  },

  Canada: {
    Québec: 'France', // New France
    Ontario: 'France',
    'New Brunswick': 'France', // Acadia
    'Nova Scotia': 'France',
    'Prince Edward Island': 'France',
    'Newfoundland and Labrador': 'Britain',
    Manitoba: 'Britain', // HBC chartered 1670 — Rupert's Land
    Saskatchewan: 'Britain',
    Alberta: 'Britain',
    'Northwest Territories': 'Britain',
    Nunavut: 'Britain',
    Yukon: 'Unclaimed',
    'British Columbia': 'Unclaimed',
  },

  India: {
    Maharashtra: 'Maratha Confederacy',
    Goa: 'Portugal', // Portuguese India
    'Dadra and Nagar Haveli and Daman and Diu': 'Portugal',
    Karnataka: 'Mysore',
    Kerala: 'Mysore',
    'Tamil Nadu': 'Mysore',
    Puducherry: 'Mysore', // French Pondicherry from 1674; pragmatic
    Lakshadweep: 'Maldives',
    'Andaman and Nicobar': 'Unclaimed',
    Sikkim: 'Nepal', // Chogyal kingdom; pragmatic neighbor
    'Arunachal Pradesh': 'Bhutan',
    'Jammu and Kashmir': 'Mughal Empire',
    Ladakh: 'Tibet',
    // Andhra Pradesh + Telangana: Qutb Shahi Golconda independent until 1687
    // — pragmatic: stays Mughal Empire (default)
  },

  Indonesia: {
    Aceh: 'Aceh',
    'Sumatera Utara': 'Aceh',
    'Kalimantan Utara': 'Brunei',
    'Kalimantan Timur': 'Brunei',
    'Nusa Tenggara Timur': 'Portugal', // Portuguese Solor/Flores
    Papua: 'Unclaimed',
    'Papua Barat': 'Unclaimed',
  },

  China: {
    Xizang: 'Tibet', // Dalai Lama + Khoshut Khan
    Xinjiang: 'Unclaimed', // Dzungar Khanate; not yet Qing
    Qinghai: 'Tibet', // Khoshut Khanate territory
    'Paracel Islands': 'Unclaimed',
  },

  Romania: {
    // Transylvania (autonomous Ottoman vassal)
    Alba: 'Transylvania',
    Arad: 'Transylvania',
    Bihor: 'Transylvania',
    'Bistrita-Nasaud': 'Transylvania',
    Brasov: 'Transylvania',
    'Caras-Severin': 'Transylvania',
    Cluj: 'Transylvania',
    Covasna: 'Transylvania',
    Harghita: 'Transylvania',
    Hunedoara: 'Transylvania',
    Maramures: 'Transylvania',
    Mures: 'Transylvania',
    Salaj: 'Transylvania',
    'Satu Mare': 'Transylvania',
    Sibiu: 'Transylvania',
    Timis: 'Transylvania',
    // Wallachia
    Arges: 'Wallachia',
    Braila: 'Wallachia',
    Bucharest: 'Wallachia',
    Buzau: 'Wallachia',
    Calarasi: 'Wallachia',
    Dâmbovita: 'Wallachia',
    Dolj: 'Wallachia',
    Giurgiu: 'Wallachia',
    Gorj: 'Wallachia',
    Ialomita: 'Wallachia',
    Ilfov: 'Wallachia',
    Mehedinti: 'Wallachia',
    Olt: 'Wallachia',
    Prahova: 'Wallachia',
    Teleorman: 'Wallachia',
    Vâlcea: 'Wallachia',
    Vrancea: 'Wallachia',
    Galati: 'Wallachia',
    // Moldavia
    Bacau: 'Moldavia',
    Botosani: 'Moldavia',
    Iasi: 'Moldavia',
    Neamt: 'Moldavia',
    Suceava: 'Moldavia',
    Vaslui: 'Moldavia',
    // Ottoman Dobruja
    Constanta: 'Ottoman Empire',
    Tulcea: 'Ottoman Empire',
  },

  Hungary: {
    // Royal Hungary (Habsburg) — narrow western strip
    'Gyor-Moson-Sopron': 'Austria',
    Gyôr: 'Austria',
    Sopron: 'Austria',
    Vas: 'Austria',
    Szombathely: 'Austria',
    Zala: 'Austria',
    Zalaegerszeg: 'Austria',
    Nagykanizsa: 'Austria',
    'Komárom-Esztergom': 'Austria',
    Veszprém: 'Austria',
    // Everything else stays Ottoman Empire (default for Hungary)
  },

  Russia: {
    Kaliningrad: 'Brandenburg-Prussia', // Königsberg, capital of Ducal Prussia
    Crimea: 'Ottoman Empire', // Crimean Khanate (Ottoman vassal)
    Sevastopol: 'Ottoman Empire',
  },

  France: {
    Savoie: 'Savoy', // Duchy of Savoy (held until 1860)
    'Haute-Savoie': 'Savoy',
    'Alpes-Maritimes': 'Savoy', // Nice
    'Corse-du-Sud': 'Genoa', // Corsica (Genoese until 1768)
    'Haute-Corse': 'Genoa',
    Mayotte: 'Unclaimed',
  },

  Ukraine: {
    // Left-bank Ukraine (east of Dnieper) + Kyiv → Russia (Hetmanate
    // came under Russian protection 1654, formalized 1667 Andrusovo)
    Kiev: 'Russia',
    'Kiev City': 'Russia',
    Chernihiv: 'Russia',
    Poltava: 'Russia',
    Sumy: 'Russia',
    Cherkasy: 'Russia',
    Kharkiv: 'Russia',
    // Black Sea steppe & Crimea hinterland — Ottoman/Crimean Tatar zone
    "Donets'k": 'Ottoman Empire',
    "Luhans'k": 'Ottoman Empire',
    Kherson: 'Ottoman Empire',
    Mykolayiv: 'Ottoman Empire',
    Odessa: 'Ottoman Empire',
    Zaporizhzhya: 'Ottoman Empire',
    "Dnipropetrovs'k": 'Ottoman Empire',
    Kirovohrad: 'Ottoman Empire',
    // Transcarpathia was Royal Hungary
    Transcarpathia: 'Austria',
    // Bukovina (Chernivtsi) was Moldavian
    Chernivtsi: 'Moldavia',
    // Western oblasts (Galicia, Volhynia, Podolia) → Poland-Lithuania (default)
  },

  'Saudi Arabia': {
    // Interior Nejd — Banu Khalid / local emirates, not Ottoman in practice
    'Ar Riyad': 'Unclaimed',
    'Al Quassim': 'Unclaimed',
    'Al Jawf': 'Unclaimed',
  },

  Afghanistan: {
    // Western: Safavid Persia (default)
    // Northern: Khanate of Bukhara
    Balkh: 'Bukhara',
    Jawzjan: 'Bukhara',
    Faryab: 'Bukhara',
    'Sari Pul': 'Bukhara',
    Samangan: 'Bukhara',
    Baghlan: 'Bukhara',
    Kunduz: 'Bukhara',
    Takhar: 'Bukhara',
    Badakhshan: 'Bukhara',
    // Eastern: Mughal (Kabul subah held since 1504)
    Kabul: 'Mughal Empire',
    Ghazni: 'Mughal Empire',
    Khost: 'Mughal Empire',
    Paktya: 'Mughal Empire',
    Paktika: 'Mughal Empire',
    Logar: 'Mughal Empire',
    Wardak: 'Mughal Empire',
    Parwan: 'Mughal Empire',
    Kapisa: 'Mughal Empire',
    Laghman: 'Mughal Empire',
    Nangarhar: 'Mughal Empire',
    Kunar: 'Mughal Empire',
    Nuristan: 'Mughal Empire',
    Bamyan: 'Mughal Empire',
  },

  Nigeria: {
    // Hausa city-states (north central / north-west)
    Sokoto: 'Hausa City-States',
    Zamfara: 'Hausa City-States',
    Kebbi: 'Hausa City-States',
    Kano: 'Hausa City-States',
    Kaduna: 'Hausa City-States',
    Katsina: 'Hausa City-States',
    Jigawa: 'Hausa City-States',
    Bauchi: 'Hausa City-States',
    // Bornu (north-east, Kanem-Bornu sphere)
    Borno: 'Bornu',
    Yobe: 'Bornu',
    Gombe: 'Bornu',
    Adamawa: 'Bornu',
    // Oyo (south-west Yoruba)
    Oyo: 'Oyo',
    Osun: 'Oyo',
    Ekiti: 'Oyo',
    Lagos: 'Oyo',
    Ogun: 'Oyo',
    Ondo: 'Oyo',
    Kwara: 'Oyo',
    // Middle Belt / Niger Delta — native / unclaimed
    Plateau: 'Unclaimed',
    Nassarawa: 'Unclaimed',
    Niger: 'Unclaimed',
    'Federal Capital Territory': 'Unclaimed',
    Kogi: 'Unclaimed',
    Benue: 'Unclaimed',
    Taraba: 'Unclaimed',
    'Cross River': 'Unclaimed',
    Rivers: 'Unclaimed',
    Bayelsa: 'Unclaimed',
    'Akwa Ibom': 'Unclaimed',
    Edo: 'Unclaimed',
    Delta: 'Unclaimed',
    Anambra: 'Unclaimed',
    Enugu: 'Unclaimed',
    Imo: 'Unclaimed',
    Abia: 'Unclaimed',
    Ebonyi: 'Unclaimed',
  },

  'South Africa': {
    // Dutch Cape Colony (founded 1652)
    'Western Cape': 'Netherlands',
    'Northern Cape': 'Netherlands',
  },
};

function ownerFor(modernCountry, provinceName) {
  const ovr = OVERRIDES[modernCountry];
  if (ovr && Object.prototype.hasOwnProperty.call(ovr, provinceName)) {
    return ovr[provinceName];
  }
  if (Object.prototype.hasOwnProperty.call(DEFAULT_OWNER, modernCountry)) {
    return DEFAULT_OWNER[modernCountry];
  }
  return 'Unclaimed';
}

// ----------------------------------------------------------------------
// 1) Rewrite provinces.geojson
// ----------------------------------------------------------------------
console.log('Reading provinces.geojson...');
const g = JSON.parse(fs.readFileSync(GEOJSON, 'utf8'));
let touched = 0;
const unmapped = new Set();
for (const f of g.features) {
  const p = f.properties;
  const owner = ownerFor(p.modern_country, p.province_name);
  if (!PALETTE_1680[owner]) {
    unmapped.add(`${p.modern_country}/${p.province_name} → ${owner}`);
  }
  if (p.owner !== owner) touched++;
  p.owner = owner;
}
if (unmapped.size > 0) {
  console.error('ERROR: owners not in PALETTE_1680:');
  for (const u of unmapped) console.error('  ' + u);
  process.exit(1);
}
console.log(`Reassigned ${touched}/${g.features.length} provinces.`);
console.log('Writing provinces.geojson...');
fs.writeFileSync(GEOJSON, JSON.stringify(g, null, 2) + '\n');

// ----------------------------------------------------------------------
// 2) owners.json + palette.json
// ----------------------------------------------------------------------
const names = Object.keys(PALETTE_1680).sort((a, b) =>
  a.toLowerCase().localeCompare(b.toLowerCase()),
);
fs.writeFileSync(OWNERS, JSON.stringify(names, null, 2) + '\n');
const sortedPalette = {};
for (const n of names) sortedPalette[n] = PALETTE_1680[n];
fs.writeFileSync(PALETTE, JSON.stringify(sortedPalette, null, 2) + '\n');
console.log(`Wrote owners.json (${names.length} countries) and palette.json`);

// ----------------------------------------------------------------------
// 3) Empty seed_forces, wipe force files
// ----------------------------------------------------------------------
fs.writeFileSync(SEED_FORCES, '[]\n');
let removed = 0;
if (fs.existsSync(FORCES_DIR)) {
  for (const f of fs.readdirSync(FORCES_DIR)) {
    if (f.endsWith('.json')) {
      fs.unlinkSync(path.join(FORCES_DIR, f));
      removed++;
    }
  }
}
console.log(`Emptied seed_forces.json and removed ${removed} force file(s).`);

// ----------------------------------------------------------------------
// 4) Re-bake state.json + per-nation force files
// ----------------------------------------------------------------------
console.log('Running bake-state.mjs...');
execFileSync('node', ['scripts/bake-state.mjs'], { stdio: 'inherit', cwd: ROOT });

// ----------------------------------------------------------------------
// 5) Verification summary
// ----------------------------------------------------------------------
const counts = {};
for (const f of g.features) counts[f.properties.owner] = (counts[f.properties.owner] || 0) + 1;
const rows = Object.entries(counts).sort((a, b) => b[1] - a[1]);
console.log('\n1680 ownership distribution:');
for (const [name, n] of rows) {
  console.log(`  ${n.toString().padStart(4)}  ${name}`);
}
console.log(`\nTotal provinces: ${g.features.length}`);
