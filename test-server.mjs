import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

const root = join(import.meta.dirname, 'public');
const parents = [
  { id: 1, name: 'Jordan', color: '#2F6D62', email: 'jordan@example.com', notify: 1 },
  { id: 2, name: 'Casey', color: '#C0702A', email: 'casey@example.com', notify: 1 }
];
const kids = [{ id: 1, name: 'Ava', hasPin: true }, { id: 2, name: 'Max', hasPin: false }];
const now = new Date();
const y = now.getFullYear();
const m = String(now.getMonth() + 1).padStart(2, '0');
const date = day => `${y}-${m}-${String(day).padStart(2, '0')}`;
let mockWeather = 'rain';
const mockWeatherData = () => {
  const conditions = {
    clear: { icon:'☀️', description:'Clear sky', temperature_f:92 },
    'partly-cloudy': { icon:'🌤️', description:'Partly cloudy', temperature_f:88 },
    cloudy: { icon:'☁️', description:'Overcast', temperature_f:78 },
    fog: { icon:'🌫️', description:'Fog', temperature_f:68 },
    rain: { icon:'🌧️', description:'Rain showers', temperature_f:74 },
    snow: { icon:'🌨️', description:'Snow', temperature_f:29 },
    storm: { icon:'⛈️', description:'Thunderstorms', temperature_f:71 }
  };
  const current = conditions[mockWeather];
  return {
    location:'Cabot, AR', observed_at:`${date(now.getDate())}T20:30`, date:date(now.getDate()),
    condition:mockWeather, apparent_temperature_f:current.temperature_f,
    stale:false, source:'Open-Meteo', ...current,
    forecast:Array.from({ length:10 }, (_, index) => {
      const kinds=['rain','partly-cloudy','clear','storm','cloudy','clear','rain','partly-cloudy','clear','cloudy'];
      const kind=index===0?mockWeather:kinds[index];
      const day=new Date(now.getFullYear(),now.getMonth(),now.getDate()+index);
      const forecastDate=`${day.getFullYear()}-${String(day.getMonth()+1).padStart(2,'0')}-${String(day.getDate()).padStart(2,'0')}`;
      return { date:forecastDate, weather_code:0, condition:kind, description:conditions[kind].description,
        icon:conditions[kind].icon, high_f:conditions[kind].temperature_f, low_f:conditions[kind].temperature_f-14,
        precipitation_probability:['rain','storm'].includes(kind)?70:10 };
    })
  };
};

const json = (res, value) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(value));
};

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/api/state') return json(res, { needsSetup: false, parents, kidLogins: [] });
  if (url.pathname === '/api/login') return json(res, { token: 'preview', parent: parents[0] });
  if (url.pathname === '/api/weather') return json(res, mockWeatherData());
  if (url.pathname === '/__weather') {
    const requested = url.searchParams.get('kind');
    if (['clear','partly-cloudy','cloudy','fog','rain','snow','storm'].includes(requested)) mockWeather = requested;
    return json(res, { condition: mockWeather });
  }
  if (url.pathname === '/api/data') return json(res, {
    role: 'parent', me: 1, parents, kids,
    schedule: { anchor_date: date(5), anchor_parent: 1 },
    overrides: [], pending: [], history: [], mailReady: true,
    appointments: [
      { id: 1, type: 'appointment', title: 'Dentist', kid_id: 1, date: date(8), end_date: null, time: '09:30', notes: '', parent_id: 1, confirmed: 1 },
      { id: 2, type: 'event', title: 'Family trip', kid_id: null, date: date(14), end_date: date(17), time: null, notes: '', parent_id: 2, confirmed: 1 },
      { id: 3, type: 'birthday', title: "Ava's birthday", kid_id: 1, date: `${y - 9}-${m}-22`, end_date: null, time: null, notes: '', parent_id: null, confirmed: 1 },
      { id: 4, type: 'oncall', title: 'On call', kid_id: null, date: date(25), end_date: date(27), time: null, notes: '', parent_id: 1, confirmed: 1 }
    ]
  });
  if (url.pathname.startsWith('/api/')) return json(res, { ok: true });

  const requested = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
  const file = normalize(join(root, requested));
  if (!file.startsWith(root)) { res.writeHead(403); return res.end(); }
  try {
    const body = await readFile(file);
    const types = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.json':'application/json', '.png':'image/png' };
    res.writeHead(200, { 'content-type': types[extname(file)] || 'application/octet-stream', 'cache-control':'no-store' });
    res.end(body);
  } catch (_) {
    res.writeHead(404); res.end('Not found');
  }
}).listen(4173, '127.0.0.1', () => console.log('Theme preview at http://127.0.0.1:4173'));

