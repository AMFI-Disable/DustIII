// world_data.js — Dust2 gameplay data in world units (x right/east, z down/south on the radar; north = -Z = CT side).
// Positions are snapped onto the nav grid at load time (world.js), so y values here are approximate.
// yaw: radians, three.js convention (0 = facing -Z/north, +PI/2 = facing -X/west, -PI/2 = facing +X/east, PI = facing +Z/south)

const R = (x0, z0, x1, z1) => [[x0, z0], [x1, z0], [x1, z1], [x0, z1]];

// Ordered by priority: the first polygon containing the point (and inside the y-range) wins.
export const CALLOUTS = [
  { name: 'Mid Doors',       poly: R(-260, -620, 110, -430),     y0: -100, y1: 260 },
  { name: 'Xbox',            poly: R(-120, -430, 160, -190),     y0: -100, y1: 400 },
  { name: 'B Doors',         poly: R(-1130, -1240, -930, -1000), y0: -100, y1: 400 },
  { name: 'Window',          poly: R(-1070, -1580, -935, -1240), y0: -100, y1: 400 },
  { name: 'Long Doors',      poly: R(800, 620, 1150, 1000),      y0: -100, y1: 400 },
  { name: 'Pit',             poly: R(1560, 470, 1970, 1170),     y0: -100, y1: 170 },
  { name: 'Side Pit',        poly: R(1950, 60, 2160, 960),       y0: -100, y1: 400 },
  { name: 'Goose',           poly: R(1740, -2090, 1980, -1780),  y0: 200, y1: 500 },
  { name: 'A Ramp',          poly: R(1560, -1680, 1990, -1000),  y0: -100, y1: 312 },
  { name: 'A Site',          poly: R(1100, -2090, 1990, -1150),  y0: 230, y1: 520 },
  { name: 'CT Spawn',        poly: R(500, -1740, 1100, -1290),   y0: 230, y1: 520 },
  { name: 'Short A',         poly: R(500, -1290, 1100, -880),    y0: 230, y1: 520 },
  { name: 'Short A',         poly: R(500, -960, 900, -580),      y0: 150, y1: 520 },
  { name: 'Catwalk',         poly: R(100, -660, 640, 480),       y0: 110, y1: 330 },
  { name: 'CT Ramp',         poly: R(880, -1300, 1560, -880),    y0: -100, y1: 260 },
  { name: 'CT Mid',          poly: R(-1000, -1500, 900, -600),   y0: -100, y1: 230 },
  { name: 'CT Path',         poly: R(-1000, -2200, 450, -1480),  y0: -100, y1: 700 },
  { name: 'Back Plat',       poly: R(-2060, -2130, -1640, -1690), y0: -100, y1: 700 },
  { name: 'Car',             poly: R(-1980, -1260, -1590, -980), y0: -100, y1: 450 },
  { name: 'B Tunnels',       poly: R(-1980, -1000, -1580, -420), y0: -100, y1: 450 },
  { name: 'B Site',          poly: R(-1770, -2130, -930, -800), y0: -100, y1: 450 },
  { name: 'Lower Tunnels',   poly: R(-960, -440, -200, 130),     y0: -100, y1: 186 },
  { name: 'Upper Tunnels',   poly: R(-2000, -440, -850, 460),    y0: -100, y1: 450 },
  { name: 'Outside Tunnels', poly: R(-1780, 450, -940, 1260),    y0: -100, y1: 450 },
  { name: 'Top Mid',         poly: R(-470, 470, 520, 960),       y0: -100, y1: 450 },
  { name: 'Mid',             poly: R(-260, -450, 110, 480),      y0: -100, y1: 300 },
  { name: 'Suicide',         poly: R(-280, 950, 40, 1730),       y0: -100, y1: 450 },
  { name: 'T Ramp',          poly: R(-200, 1760, 830, 2230),     y0: -100, y1: 450 },
  { name: 'T Spawn',         poly: R(-700, 1760, -200, 2260),    y0: -100, y1: 600 },
  { name: 'Outside Tunnels', poly: R(-1990, 1250, -700, 2260),   y0: -100, y1: 600 },
  { name: 'Outside Long',    poly: R(420, 960, 1150, 1720),      y0: -100, y1: 450 },
  { name: 'Outside Long',    poly: R(520, 580, 1150, 960),       y0: -100, y1: 450 },
  { name: 'Blue',            poly: R(800, 250, 1580, 980),       y0: -100, y1: 450 },
  { name: 'Long A',          poly: R(1080, -1050, 2160, 500),    y0: -100, y1: 450 },
];

// 5 primary spawns + alternates per side (CS2 has ~10)
const CT_YAW = -2.6, T_YAW = -1.25;   // T faces east toward T Ramp / mid
export const SPAWNS = {
  // CT: courtyard west of A site (behind A, above Short), facing toward Short / A
  ct: [
    { pos: [660, 288, -1540], yaw: CT_YAW }, { pos: [770, 288, -1540], yaw: CT_YAW }, { pos: [880, 288, -1540], yaw: CT_YAW },
    { pos: [715, 288, -1450], yaw: CT_YAW }, { pos: [825, 288, -1450], yaw: CT_YAW },
  ],
  ctAlt: [
    { pos: [990, 288, -1540], yaw: CT_YAW }, { pos: [935, 288, -1450], yaw: CT_YAW }, { pos: [660, 288, -1420], yaw: CT_YAW },
    { pos: [1045, 288, -1450], yaw: CT_YAW }, { pos: [770, 288, -1380], yaw: CT_YAW },
  ],
  // T: raised platform south of mid (Suicide drops north into mid, T Ramp descends east to Outside Long)
  t: [
    { pos: [-560, 320, 1880], yaw: T_YAW }, { pos: [-460, 320, 1880], yaw: T_YAW }, { pos: [-360, 320, 1880], yaw: T_YAW },
    { pos: [-510, 320, 1980], yaw: T_YAW }, { pos: [-410, 320, 1980], yaw: T_YAW },
  ],
  tAlt: [
    { pos: [-310, 320, 1980], yaw: T_YAW }, { pos: [-560, 330, 2060], yaw: T_YAW }, { pos: [-460, 330, 2060], yaw: T_YAW },
    { pos: [-360, 330, 2060], yaw: T_YAW }, { pos: [-610, 320, 1980], yaw: T_YAW },
  ],
};

// Plantable areas (xz polygon + y range)
export const BOMBSITES = {
  A: { center: [1470, 288, -1295], poly: [[1150, -1180], [1560, -1180], [1560, -1660], [1960, -1660], [1960, -2060], [1290, -2060], [1290, -1640], [1150, -1640]], y0: 250, y1: 430 },
  B: { center: [-1282, 192, -1568], poly: [[-1760, -1200], [-1000, -1200], [-1000, -2000], [-1760, -2000]], y0: 140, y1: 360 },
};

// Named strategic points for bots (arrays of [x,y,z] are converted to Vector3 and snapped onto the nav grid)
export const BOT_POINTS = {
  areas: {
    'T Spawn': [-460, 320, 1930], 'T Ramp': [520, 250, 1900], 'Outside Long': [800, 200, 1250], 'Long Doors': [960, 200, 820],
    'Blue': [1350, 200, 620], 'Pit': [1760, 20, 900], 'Long A': [1780, 200, -300], 'A Ramp': [1760, 250, -1150],
    'A Site': [1470, 288, -1295], 'Goose': [1850, 340, -1940], 'CT Spawn': [820, 288, -1490], 'Short A': [720, 288, -820],
    'Catwalk': [380, 200, -420], 'Xbox': [80, 64, -300], 'Mid': [-80, 100, 100], 'Top Mid': [0, 200, 720], 'Suicide': [-120, 220, 1300],
    'Mid Doors': [-80, 64, -520], 'CT Mid': [-200, 64, -1000], 'B Doors': [-1030, 200, -1110], 'Window': [-1000, 200, -1400],
    'B Site': [-1282, 192, -1568], 'Back Plat': [-1800, 224, -1880], 'Car': [-1780, 200, -1120], 'B Tunnels': [-1760, 220, -700],
    'Upper Tunnels': [-1400, 220, -200], 'Lower Tunnels': [-600, 80, -280], 'Outside Tunnels': [-1350, 200, 900],
  },
  ct: [
    { name: 'A Site default', pos: [1470, 288, -1360] },
    { name: 'A Goose', pos: [1860, 340, -1950] },
    { name: 'A Ramp top (long hold)', pos: [1700, 300, -1420] },
    { name: 'A Short hold', pos: [1180, 288, -1500] },
    { name: 'Long A corner', pos: [1700, 200, -800] },
    { name: 'CT Spawn', pos: [820, 288, -1490] },
    { name: 'Short top', pos: [800, 288, -1100] },
    { name: 'Mid Doors', pos: [-100, 64, -700] },
    { name: 'CT Mid', pos: [100, 64, -1100] },
    { name: 'B Doors', pos: [-950, 200, -1150] },
    { name: 'Window', pos: [-960, 200, -1420] },
    { name: 'B Site default', pos: [-1300, 192, -1500] },
    { name: 'B Back Plat', pos: [-1800, 224, -1900] },
    { name: 'B Car (tunnel exit hold)', pos: [-1500, 200, -1250] },
  ],
  t: [
    { name: 'T Spawn', pos: [-460, 320, 1930] },
    { name: 'Outside Long', pos: [800, 200, 1250] },
    { name: 'Long Doors', pos: [960, 200, 820] },
    { name: 'Blue', pos: [1350, 200, 620] },
    { name: 'Top Mid', pos: [0, 200, 720] },
    { name: 'Xbox', pos: [80, 64, -300] },
    { name: 'Catwalk', pos: [380, 200, -420] },
    { name: 'Outside Tunnels', pos: [-1350, 200, 900] },
    { name: 'Upper Tunnels', pos: [-1400, 220, -200] },
    { name: 'B Tunnels', pos: [-1760, 220, -700] },
    { name: 'Lower Tunnels', pos: [-600, 80, -280] },
  ],
  routes: {
    'long A':      [[-460, 320, 1930], [520, 250, 1900], [800, 200, 1250], [960, 200, 820], [1350, 200, 620], [1780, 200, -300], [1760, 250, -1150], [1470, 288, -1295]],
    'short A':     [[-460, 320, 1930], [-120, 220, 1300], [0, 200, 720], [-80, 100, 100], [80, 64, -300], [380, 200, -420], [720, 288, -820], [1000, 288, -1150], [1470, 288, -1295]],
    'B tunnels':   [[-460, 320, 1930], [-1230, 320, 1700], [-1350, 200, 900], [-1300, 220, 350], [-1400, 220, -200], [-1760, 220, -700], [-1600, 200, -1150], [-1282, 192, -1568]],
    'mid to B':    [[-460, 320, 1930], [-120, 220, 1300], [0, 200, 720], [-80, 100, 100], [-600, 80, -280], [-1400, 220, -200], [-1760, 220, -700], [-1282, 192, -1568]],
    'mid':         [[-460, 320, 1930], [-120, 220, 1300], [0, 200, 720], [-80, 100, 100], [-80, 64, -520], [-200, 64, -1000]],
    'mid to B doors': [[-80, 64, -520], [-200, 64, -1000], [-700, 150, -1100], [-1030, 200, -1110], [-1282, 192, -1568]],
    'CT to A':     [[820, 288, -1490], [1470, 288, -1360]],
    'CT to B':     [[820, 288, -1490], [400, 100, -1150], [-200, 64, -1000], [-1030, 200, -1110], [-1300, 192, -1500]],
  },
  plant: {
    A: [[1470, 288, -1300], [1820, 340, -1900], [1600, 288, -1450], [1350, 288, -1500]],
    B: [[-1282, 192, -1568], [-1500, 192, -1700], [-1150, 192, -1350], [-1650, 224, -1850]],
  },
  smokes: {
    'Xbox (cross to short)': [60, 64, -330], 'CT Spawn (A)': [900, 288, -1400], 'Long Corner cross': [1750, 200, -900],
    'A Ramp / site': [1650, 300, -1300], 'B Doors': [-1040, 200, -1100], 'B Window': [-1000, 200, -1400], 'Mid Doors': [-80, 64, -520],
    'B Tunnels exit': [-1750, 220, -850],
  },
  flashes: {
    'Long A': [1780, 400, -300], 'A Site over short': [1100, 450, -1150], 'B Site from tunnels': [-1600, 350, -1300], 'Mid': [-80, 300, -200],
  },
};
