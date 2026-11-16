// Lazygit search/filter behavior at 54cc6af1d77b5a6cec3dc9ad0b203afdb4ad3451.
// Fuzzy matcher ported from vendored github.com/sahilm/fuzzy v0.1.3.
// Substring filter: pkg/utils/search.go. Literal commit search:
// pkg/gui/controllers/helpers/search_helper.go + context/local_commits_context.go.
// All helpers are pure and preserve the original item indexes.
//
// The MIT License (MIT)
// Copyright (c) 2017 Sahil Muthoo
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
// THE SOFTWARE.

// Unicode 17.0.0 data generated from the same Go 1.27.1 runtime as the reference
// binary (unicode.SimpleFold/ToLower/IsUpper/IsLower). Host JS lowercasing is not
// interchangeable: it expands dotted I and applies contextual Greek sigma.
// Rows are [start,end,stride,delta] for maps, [start,end,stride] for properties.
const FOLD = [
  [97,122,1,-32],[224,246,1,-32],[248,254,1,-32],[257,303,2,-1],[307,311,2,-1],[314,328,2,-1],
  [331,375,2,-1],[376,376,1,-121],[378,382,2,-1],[383,383,1,-300],[387,389,2,-1],[392,396,4,-1],
  [402,409,7,-1],[417,421,2,-1],[424,429,5,-1],[432,436,4,-1],[438,441,3,-1],[445,453,8,-1],
  [454,454,1,-2],[456,456,1,-1],[457,457,1,-2],[459,459,1,-1],[460,460,1,-2],[462,476,2,-1],
  [477,477,1,-79],[479,495,2,-1],[498,498,1,-1],[499,499,1,-2],[501,501,1,-1],[502,502,1,-97],
  [503,503,1,-56],[505,543,2,-1],[544,544,1,-130],[547,563,2,-1],[572,572,1,-1],[573,573,1,-163],
  [578,578,1,-1],[579,579,1,-195],[583,591,2,-1],[595,595,1,-210],[596,596,1,-206],[598,599,1,-205],
  [601,601,1,-202],[603,603,1,-203],[608,608,1,-205],[611,611,1,-207],[616,616,1,-209],[617,623,6,-211],
  [626,626,1,-213],[629,629,1,-214],[640,643,3,-218],[648,648,1,-218],[649,649,1,-69],[650,651,1,-217],
  [652,652,1,-71],[658,658,1,-219],[881,883,2,-1],[887,887,1,-1],[921,921,1,-84],[924,924,1,-743],
  [940,940,1,-38],[941,943,1,-37],[945,952,1,-32],[953,953,1,-116],[954,955,1,-32],[956,956,1,-775],
  [957,961,1,-32],[962,962,1,-31],[963,971,1,-32],[972,972,1,-64],[973,974,1,-63],[976,976,1,-62],
  [977,977,1,-57],[981,981,1,-47],[982,982,1,-54],[983,983,1,-8],[985,1007,2,-1],[1008,1008,1,-86],
  [1009,1009,1,-80],[1011,1011,1,-116],[1012,1012,1,-92],[1013,1013,1,-96],[1016,1016,1,-1],[1017,1017,1,-7],
  [1019,1019,1,-1],[1021,1023,1,-130],[1072,1103,1,-32],[1104,1119,1,-80],[1121,1153,2,-1],[1163,1215,2,-1],
  [1218,1230,2,-1],[1231,1231,1,-15],[1233,1327,2,-1],[1377,1414,1,-48],[5112,5117,1,-8],[7296,7296,1,-6254],
  [7297,7297,1,-6253],[7298,7298,1,-6244],[7299,7300,1,-6242],[7301,7301,1,-6243],[7302,7302,1,-6236],[7303,7303,1,-6181],
  [7306,7306,1,-1],[7312,7354,1,-3008],[7357,7359,1,-3008],[7681,7829,2,-1],[7835,7835,1,-59],[7838,7838,1,-7615],
  [7841,7935,2,-1],[7944,7951,1,-8],[7960,7965,1,-8],[7976,7983,1,-8],[7992,7999,1,-8],[8008,8013,1,-8],
  [8025,8031,2,-8],[8040,8047,1,-8],[8072,8079,1,-8],[8088,8095,1,-8],[8104,8111,1,-8],[8120,8121,1,-8],
  [8122,8123,1,-74],[8124,8124,1,-9],[8126,8126,1,-7289],[8136,8139,1,-86],[8140,8140,1,-9],[8147,8147,1,-7235],
  [8152,8153,1,-8],[8154,8155,1,-100],[8163,8163,1,-7219],[8168,8169,1,-8],[8170,8171,1,-112],[8172,8172,1,-7],
  [8184,8185,1,-128],[8186,8187,1,-126],[8188,8188,1,-9],[8486,8486,1,-7549],[8490,8490,1,-8415],[8491,8491,1,-8294],
  [8526,8526,1,-28],[8560,8575,1,-16],[8580,8580,1,-1],[9424,9449,1,-26],[11312,11359,1,-48],[11361,11361,1,-1],
  [11362,11362,1,-10743],[11363,11363,1,-3814],[11364,11364,1,-10727],[11365,11365,1,-10795],[11366,11366,1,-10792],[11368,11372,2,-1],
  [11373,11373,1,-10780],[11374,11374,1,-10749],[11375,11375,1,-10783],[11376,11376,1,-10782],[11379,11382,3,-1],[11390,11391,1,-10815],
  [11393,11491,2,-1],[11500,11502,2,-1],[11507,11507,1,-1],[11520,11557,1,-7264],[11559,11565,6,-7264],[42561,42569,2,-1],
  [42570,42570,1,-35266],[42571,42571,1,-35267],[42573,42605,2,-1],[42625,42651,2,-1],[42787,42799,2,-1],[42803,42863,2,-1],
  [42874,42876,2,-1],[42877,42877,1,-35332],[42879,42887,2,-1],[42892,42892,1,-1],[42893,42893,1,-42280],[42897,42899,2,-1],
  [42903,42921,2,-1],[42922,42922,1,-42308],[42923,42923,1,-42319],[42924,42924,1,-42315],[42925,42925,1,-42305],[42926,42926,1,-42308],
  [42928,42928,1,-42258],[42929,42929,1,-42282],[42930,42930,1,-42261],[42933,42947,2,-1],[42948,42948,1,-48],[42949,42949,1,-42307],
  [42950,42950,1,-35384],[42952,42954,2,-1],[42955,42955,1,-42343],[42957,42971,2,-1],[42972,42972,1,-42561],[42998,42998,1,-1],
  [43859,43859,1,-928],[43888,43967,1,-38864],[64262,64262,1,-1],[65345,65370,1,-32],[66600,66639,1,-40],[66776,66811,1,-40],
  [66967,66977,1,-39],[66979,66993,1,-39],[66995,67001,1,-39],[67003,67004,1,-39],[68800,68850,1,-64],[68976,68997,1,-32],
  [71872,71903,1,-32],[93792,93823,1,-32],[93883,93907,1,-27],[125218,125251,1,-34],
];
const LOWER = [
  [65,90,1,32],[192,214,1,32],[216,222,1,32],[256,302,2,1],[304,304,1,-199],[306,310,2,1],
  [313,327,2,1],[330,374,2,1],[376,376,1,-121],[377,381,2,1],[385,385,1,210],[386,388,2,1],
  [390,390,1,206],[391,391,1,1],[393,394,1,205],[395,395,1,1],[398,398,1,79],[399,399,1,202],
  [400,400,1,203],[401,401,1,1],[403,403,1,205],[404,404,1,207],[406,406,1,211],[407,407,1,209],
  [408,408,1,1],[412,412,1,211],[413,413,1,213],[415,415,1,214],[416,420,2,1],[422,422,1,218],
  [423,423,1,1],[425,425,1,218],[428,428,1,1],[430,430,1,218],[431,431,1,1],[433,434,1,217],
  [435,437,2,1],[439,439,1,219],[440,444,4,1],[452,452,1,2],[453,453,1,1],[455,455,1,2],
  [456,456,1,1],[458,458,1,2],[459,475,2,1],[478,494,2,1],[497,497,1,2],[498,500,2,1],
  [502,502,1,-97],[503,503,1,-56],[504,542,2,1],[544,544,1,-130],[546,562,2,1],[570,570,1,10795],
  [571,571,1,1],[573,573,1,-163],[574,574,1,10792],[577,577,1,1],[579,579,1,-195],[580,580,1,69],
  [581,581,1,71],[582,590,2,1],[880,882,2,1],[886,886,1,1],[895,895,1,116],[902,902,1,38],
  [904,906,1,37],[908,908,1,64],[910,911,1,63],[913,929,1,32],[931,939,1,32],[975,975,1,8],
  [984,1006,2,1],[1012,1012,1,-60],[1015,1015,1,1],[1017,1017,1,-7],[1018,1018,1,1],[1021,1023,1,-130],
  [1024,1039,1,80],[1040,1071,1,32],[1120,1152,2,1],[1162,1214,2,1],[1216,1216,1,15],[1217,1229,2,1],
  [1232,1326,2,1],[1329,1366,1,48],[4256,4293,1,7264],[4295,4301,6,7264],[5024,5103,1,38864],[5104,5109,1,8],
  [7305,7305,1,1],[7312,7354,1,-3008],[7357,7359,1,-3008],[7680,7828,2,1],[7838,7838,1,-7615],[7840,7934,2,1],
  [7944,7951,1,-8],[7960,7965,1,-8],[7976,7983,1,-8],[7992,7999,1,-8],[8008,8013,1,-8],[8025,8031,2,-8],
  [8040,8047,1,-8],[8072,8079,1,-8],[8088,8095,1,-8],[8104,8111,1,-8],[8120,8121,1,-8],[8122,8123,1,-74],
  [8124,8124,1,-9],[8136,8139,1,-86],[8140,8140,1,-9],[8152,8153,1,-8],[8154,8155,1,-100],[8168,8169,1,-8],
  [8170,8171,1,-112],[8172,8172,1,-7],[8184,8185,1,-128],[8186,8187,1,-126],[8188,8188,1,-9],[8486,8486,1,-7517],
  [8490,8490,1,-8383],[8491,8491,1,-8262],[8498,8498,1,28],[8544,8559,1,16],[8579,8579,1,1],[9398,9423,1,26],
  [11264,11311,1,48],[11360,11360,1,1],[11362,11362,1,-10743],[11363,11363,1,-3814],[11364,11364,1,-10727],[11367,11371,2,1],
  [11373,11373,1,-10780],[11374,11374,1,-10749],[11375,11375,1,-10783],[11376,11376,1,-10782],[11378,11381,3,1],[11390,11391,1,-10815],
  [11392,11490,2,1],[11499,11501,2,1],[11506,42560,31054,1],[42562,42604,2,1],[42624,42650,2,1],[42786,42798,2,1],
  [42802,42862,2,1],[42873,42875,2,1],[42877,42877,1,-35332],[42878,42886,2,1],[42891,42891,1,1],[42893,42893,1,-42280],
  [42896,42898,2,1],[42902,42920,2,1],[42922,42922,1,-42308],[42923,42923,1,-42319],[42924,42924,1,-42315],[42925,42925,1,-42305],
  [42926,42926,1,-42308],[42928,42928,1,-42258],[42929,42929,1,-42282],[42930,42930,1,-42261],[42931,42931,1,928],[42932,42946,2,1],
  [42948,42948,1,-48],[42949,42949,1,-42307],[42950,42950,1,-35384],[42951,42953,2,1],[42955,42955,1,-42343],[42956,42970,2,1],
  [42972,42972,1,-42561],[42997,42997,1,1],[65313,65338,1,32],[66560,66599,1,40],[66736,66771,1,40],[66928,66938,1,39],
  [66940,66954,1,39],[66956,66962,1,39],[66964,66965,1,39],[68736,68786,1,64],[68944,68965,1,32],[71840,71871,1,32],
  [93760,93791,1,32],[93856,93880,1,27],[125184,125217,1,34],
];
const UPPER_CLASS = [
  [65,90,1],[192,214,1],[216,222,1],[256,310,2],[313,327,2],[330,376,2],
  [377,381,2],[385,386,1],[388,390,2],[391,393,2],[394,395,1],[398,401,1],
  [403,404,1],[406,408,1],[412,413,1],[415,416,1],[418,422,2],[423,425,2],
  [428,430,2],[431,433,2],[434,435,1],[437,439,2],[440,444,4],[452,461,3],
  [463,475,2],[478,494,2],[497,500,3],[502,504,1],[506,562,2],[570,571,1],
  [573,574,1],[577,579,2],[580,582,1],[584,590,2],[880,882,2],[886,895,9],
  [902,904,2],[905,906,1],[908,910,2],[911,913,2],[914,929,1],[931,939,1],
  [975,978,3],[979,980,1],[984,1006,2],[1012,1015,3],[1017,1018,1],[1021,1071,1],
  [1120,1152,2],[1162,1216,2],[1217,1229,2],[1232,1326,2],[1329,1366,1],[4256,4293,1],
  [4295,4301,6],[5024,5109,1],[7305,7312,7],[7313,7354,1],[7357,7359,1],[7680,7828,2],
  [7838,7934,2],[7944,7951,1],[7960,7965,1],[7976,7983,1],[7992,7999,1],[8008,8013,1],
  [8025,8031,2],[8040,8047,1],[8120,8123,1],[8136,8139,1],[8152,8155,1],[8168,8172,1],
  [8184,8187,1],[8450,8455,5],[8459,8461,1],[8464,8466,1],[8469,8473,4],[8474,8477,1],
  [8484,8490,2],[8491,8493,1],[8496,8499,1],[8510,8511,1],[8517,8579,62],[11264,11311,1],
  [11360,11362,2],[11363,11364,1],[11367,11373,2],[11374,11376,1],[11378,11381,3],[11390,11392,1],
  [11394,11490,2],[11499,11501,2],[11506,42560,31054],[42562,42604,2],[42624,42650,2],[42786,42798,2],
  [42802,42862,2],[42873,42877,2],[42878,42886,2],[42891,42893,2],[42896,42898,2],[42902,42922,2],
  [42923,42926,1],[42928,42932,1],[42934,42948,2],[42949,42951,1],[42953,42955,2],[42956,42972,2],
  [42997,65313,22316],[65314,65338,1],[66560,66599,1],[66736,66771,1],[66928,66938,1],[66940,66954,1],
  [66956,66962,1],[66964,66965,1],[68736,68786,1],[68944,68965,1],[71840,71871,1],[93760,93791,1],
  [93856,93880,1],[119808,119833,1],[119860,119885,1],[119912,119937,1],[119964,119966,2],[119967,119973,3],
  [119974,119977,3],[119978,119980,1],[119982,119989,1],[120016,120041,1],[120068,120069,1],[120071,120074,1],
  [120077,120084,1],[120086,120092,1],[120120,120121,1],[120123,120126,1],[120128,120132,1],[120134,120138,4],
  [120139,120144,1],[120172,120197,1],[120224,120249,1],[120276,120301,1],[120328,120353,1],[120380,120405,1],
  [120432,120457,1],[120488,120512,1],[120546,120570,1],[120604,120628,1],[120662,120686,1],[120720,120744,1],
  [120778,125184,4406],[125185,125217,1],
];
const LOWER_CLASS = [
  [97,122,1],[181,223,42],[224,246,1],[248,255,1],[257,311,2],[312,328,2],
  [329,375,2],[378,382,2],[383,384,1],[387,389,2],[392,396,4],[397,402,5],
  [405,409,4],[410,411,1],[414,417,3],[419,421,2],[424,426,2],[427,429,2],
  [432,436,4],[438,441,3],[442,445,3],[446,447,1],[454,460,3],[462,476,2],
  [477,495,2],[496,499,3],[501,505,4],[507,563,2],[564,569,1],[572,575,3],
  [576,578,2],[583,591,2],[592,659,1],[662,687,1],[881,883,2],[887,891,4],
  [892,893,1],[912,940,28],[941,974,1],[976,977,1],[981,983,1],[985,1007,2],
  [1008,1011,1],[1013,1019,3],[1020,1072,52],[1073,1119,1],[1121,1153,2],[1163,1215,2],
  [1218,1230,2],[1231,1327,2],[1376,1416,1],[4304,4346,1],[4349,4351,1],[5112,5117,1],
  [7296,7304,1],[7306,7424,118],[7425,7467,1],[7531,7543,1],[7545,7578,1],[7681,7829,2],
  [7830,7837,1],[7839,7935,2],[7936,7943,1],[7952,7957,1],[7968,7975,1],[7984,7991,1],
  [8000,8005,1],[8016,8023,1],[8032,8039,1],[8048,8061,1],[8064,8071,1],[8080,8087,1],
  [8096,8103,1],[8112,8116,1],[8118,8119,1],[8126,8130,4],[8131,8132,1],[8134,8135,1],
  [8144,8147,1],[8150,8151,1],[8160,8167,1],[8178,8180,1],[8182,8183,1],[8458,8462,4],
  [8463,8467,4],[8495,8505,5],[8508,8509,1],[8518,8521,1],[8526,8580,54],[11312,11359,1],
  [11361,11365,4],[11366,11372,2],[11377,11379,2],[11380,11382,2],[11383,11387,1],[11393,11491,2],
  [11492,11500,8],[11502,11507,5],[11520,11557,1],[11559,11565,6],[42561,42605,2],[42625,42651,2],
  [42787,42799,2],[42800,42801,1],[42803,42865,2],[42866,42872,1],[42874,42876,2],[42879,42887,2],
  [42892,42894,2],[42897,42899,2],[42900,42901,1],[42903,42921,2],[42927,42933,6],[42935,42947,2],
  [42952,42954,2],[42957,42971,2],[42998,43002,4],[43824,43866,1],[43872,43880,1],[43888,43967,1],
  [64256,64262,1],[64275,64279,1],[65345,65370,1],[66600,66639,1],[66776,66811,1],[66967,66977,1],
  [66979,66993,1],[66995,67001,1],[67003,67004,1],[68800,68850,1],[68976,68997,1],[71872,71903,1],
  [93792,93823,1],[93883,93907,1],[119834,119859,1],[119886,119892,1],[119894,119911,1],[119938,119963,1],
  [119990,119993,1],[119995,119997,2],[119998,120003,1],[120005,120015,1],[120042,120067,1],[120094,120119,1],
  [120146,120171,1],[120198,120223,1],[120250,120275,1],[120302,120327,1],[120354,120379,1],[120406,120431,1],
  [120458,120485,1],[120514,120538,1],[120540,120545,1],[120572,120596,1],[120598,120603,1],[120630,120654,1],
  [120656,120661,1],[120688,120712,1],[120714,120719,1],[120746,120770,1],[120772,120777,1],[120779,122624,1845],
  [122625,122633,1],[122635,122654,1],[122661,122666,1],[125218,125251,1],
];

function rangeFor(code, ranges) {
  let low = 0, high = ranges.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1, range = ranges[mid];
    if (code < range[0]) high = mid - 1;
    else if (code > range[1]) low = mid + 1;
    else return (code - range[0]) % range[2] === 0 ? range : null;
  }
  return null;
}

const mapped = (code, table) => code + (rangeFor(code, table)?.[3] || 0);
const isUpper = code => code < 128 ? code >= 65 && code <= 90 : Boolean(rangeFor(code, UPPER_CLASS));
const isLower = code => code < 128 ? code >= 97 && code <= 122 : Boolean(rangeFor(code, LOWER_CLASS));
const sameFold = (a, b) => {
  if (a === b) return true;
  if (a < 128 && b < 128) return (a >= 65 && a <= 90 ? a + 32 : a) === (b >= 65 && b <= 90 ? b + 32 : b);
  return mapped(a, FOLD) === mapped(b, FOLD);
};
const byteLength = code => code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
const SEPARATORS = new Set([47, 45, 95, 32, 46, 92]); // / - _ space . backslash
const int64 = value => BigInt.asIntN(64, value);
const NON_ASCII = /[^\x00-\x7f]/;

function text(value) {
  if (typeof value !== 'string') throw new TypeError('Search values must be strings');
  return value;
}

function runeValues(value) {
  return [...value].map(char => {
    const code = char.codePointAt(0);
    // Go's UTF-8 decoding replaces isolated surrogate code points.
    return code >= 0xd800 && code <= 0xdfff ? 0xfffd : code;
  });
}

function lower(value) {
  if (!NON_ASCII.test(value)) return value.toLowerCase();
  return runeValues(value).map(code => String.fromCodePoint(code < 128 ?
    code >= 65 && code <= 90 ? code + 32 : code : mapped(code, LOWER))).join('');
}

// Same scoring loop specialized for the common short ASCII filename query.
// Avoiding rune allocation/Unicode lookups matters under the native UI budget.
function asciiFuzzyMatch(pattern, value, folded) {
  const matchedIndexes = [];
  let patternIndex = 0, bestScore = -1, matchedIndex = -1, adjacentBonus = 0, totalScore = 0, last = 0;
  for (let j = 0; j < value.length; j++) {
    const candidate = value.charCodeAt(j);
    if (folded.charCodeAt(j) === pattern.charCodeAt(patternIndex)) {
      let score = j === 0 ? 10 : 0;
      if (last >= 97 && last <= 122 && candidate >= 65 && candidate <= 90) score += 20;
      if (j !== 0 && SEPARATORS.has(last)) score += 20;
      if (matchedIndexes.length) {
        const bonus = matchedIndexes[matchedIndexes.length - 1] === j - 1 ? adjacentBonus * 2 + 5 : 0;
        score += bonus; adjacentBonus += bonus;
      }
      if (score > bestScore) { bestScore = score; matchedIndex = j; }
    }
    const nextPattern = patternIndex < pattern.length - 1 ? pattern.charCodeAt(patternIndex + 1) : 0;
    const nextCandidate = j < value.length - 1 ? folded.charCodeAt(j + 1) : 0;
    if (nextPattern === nextCandidate || nextCandidate === 0) {
      if (matchedIndex > -1) {
        if (!matchedIndexes.length) bestScore += Math.max(matchedIndex * -5, -15);
        totalScore += bestScore; matchedIndexes.push(matchedIndex); bestScore = -1; patternIndex++;
      }
    }
    last = candidate;
  }
  totalScore += matchedIndexes.length - value.length;
  return matchedIndexes.length === pattern.length ? { totalScore, matchedIndexes } : null;
}

function fuzzyMatches(pattern, strings) {
  if (pattern === '') return [];
  const wanted = runeValues(pattern);
  // Every adjacent bonus can grow at most once per pattern rune. Short
  // patterns stay exactly representable as numbers; only long queries need
  // the signed-64-bit path. This keeps native live filtering inexpensive.
  const wide = wanted.length >= 30;
  const cast = wide ? BigInt : Number;
  const wrap = wide ? int64 : value => value;
  const zero = cast(0), one = cast(1), two = cast(2), five = cast(5), ten = cast(10), twenty = cast(20);
  const asciiPattern = !NON_ASCII.test(pattern) ? pattern.toLowerCase() : null;
  const matches = [];
  strings.forEach((value, index) => {
    text(value);
    const nul = value.indexOf('\0');
    const clean = nul < 0 ? value : value.slice(0, nul);
    if (asciiPattern !== null && !NON_ASCII.test(clean)) {
      const folded = clean.toLowerCase();
      // A matching subsequence is necessary for any fuzzy match. The native
      // string scan rejects unrelated filenames without allocating rune arrays.
      let after = 0;
      for (let i = 0; i < asciiPattern.length; i++) {
        const found = folded.indexOf(asciiPattern[i], after);
        if (found < 0) return;
        after = found + 1;
      }
      if (!wide) {
        const match = asciiFuzzyMatch(asciiPattern, clean, folded);
        if (match) matches.push({ index, ...match });
        return;
      }
    }
    const runes = runeValues(clean);
    const matchedIndexes = [];
    let patternIndex = 0, bestScore = -one, matchedIndex = -1, adjacentBonus = zero;
    let last = 0, lastIndex = 0, offset = 0, totalScore = zero;
    for (let i = 0; i < runes.length; i++) {
      const candidate = runes[i];
      if (sameFold(candidate, wanted[patternIndex])) {
        let score = zero;
        if (offset === 0) score += ten;
        if (isLower(last) && isUpper(candidate)) score += twenty;
        if (offset !== 0 && SEPARATORS.has(last)) score += twenty;
        if (matchedIndexes.length) {
          const bonus = matchedIndexes[matchedIndexes.length - 1] === lastIndex ? wrap(adjacentBonus * two + five) : zero;
          score = wrap(score + bonus);
          adjacentBonus = wrap(adjacentBonus + bonus);
        }
        if (score > bestScore) { bestScore = score; matchedIndex = offset; }
      }
      const nextPattern = wanted[patternIndex + 1] || 0;
      const nextCandidate = runes[i + 1] || 0;
      // Delay a match until the next pattern rune is coming up, or input ends,
      // to prefer stronger matches later in the same string (Black Knight).
      if (sameFold(nextPattern, nextCandidate) || nextCandidate === 0) {
        if (matchedIndex > -1) {
          if (!matchedIndexes.length) bestScore = wrap(bestScore + cast(Math.max(matchedIndex * -5, -15)));
          totalScore = wrap(totalScore + bestScore);
          matchedIndexes.push(matchedIndex);
          bestScore = -one;
          patternIndex++;
        }
      }
      lastIndex = offset; last = candidate; offset += byteLength(candidate);
    }
    totalScore = wrap(totalScore + cast(matchedIndexes.length - offset));
    if (matchedIndexes.length === wanted.length) matches.push({ index, matchedIndexes, totalScore });
  });
  // Stable ties preserve list order. Compare the signed 64-bit score before
  // conversion to JS number, including overflow for very long adjacent runs.
  matches.sort((a, b) => a.totalScore > b.totalScore ? -1 : a.totalScore < b.totalScore ? 1 : a.index - b.index);
  return matches.map(({ index, matchedIndexes, totalScore }) => ({ index, score: Number(totalScore), matchedIndexes }));
}

// strings.Fields uses Unicode White_Space, including NEL but excluding BOM.
const FIELD_SPACE = /[\u0009-\u000d\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+/;

/** Lazygit filter matches. Substrings AND whitespace-separated terms in any
 * order, with ASCII-uppercase smart case per term, and retain list order.
 * Fuzzy matching is case-insensitive and sorted by score, ties stable.
 * Fuzzy matchedIndexes are UTF-8 BYTE offsets, exactly as upstream, not JS
 * character offsets. Empty pattern: substring matches all, fuzzy matches none.
 */
export function searchMatches(pattern, strings, { fuzzy = false } = {}) {
  text(pattern);
  if (fuzzy) return fuzzyMatches(pattern, strings);
  const terms = pattern.split(FIELD_SPACE).filter(Boolean).map(value => ({
    value: /[A-Z]/.test(value) ? value : lower(value), sensitive: /[A-Z]/.test(value),
  }));
  const matches = [];
  strings.forEach((value, index) => {
    text(value);
    let normalized;
    if (terms.every(term => term.sensitive ? value.includes(term.value) :
      (normalized ??= lower(value)).includes(term.value))) matches.push({ index });
  });
  return matches;
}

/** FilteredList behavior: an empty filter restores all items in source order.
 * textForItem may return a string or multiple fields joined with one space,
 * as Lazygit's FilteredList does. Returned items preserve their identities.
 */
export function filterItems(items, pattern, textForItem = String, options = {}) {
  text(pattern);
  if (pattern === '') return items.slice();
  const strings = items.map((item, index) => {
    const value = textForItem(item, index);
    return Array.isArray(value) ? value.map(text).join(' ') : text(value);
  });
  return searchMatches(pattern, strings, options).map(match => items[match.index]);
}

/** Whole-pattern search membership, without filtering/ranking or word splitting.
 * Commit model search uses ASCII smart case for the entire pattern. Rows may
 * be arrays of separate fields (hash/subject/tags); matches never cross fields.
 * unicodeCase models gocui's different main-text smart-case rule, for membership
 * only. This helper does not return terminal grapheme/cell highlight positions.
 */
export function literalSearchMatches(pattern, rows, { unicodeCase = false } = {}) {
  text(pattern);
  if (pattern === '') return [];
  const sensitive = unicodeCase ? runeValues(pattern).some(isUpper) : /[A-Z]/.test(pattern);
  const needle = sensitive ? pattern : lower(pattern);
  const matches = [];
  rows.forEach((row, index) => {
    const fields = Array.isArray(row) ? row : [row];
    if (fields.some(field => (sensitive ? text(field) : lower(text(field))).includes(needle))) matches.push({ index });
  });
  return matches;
}
