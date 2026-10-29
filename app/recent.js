// Recently visited lessons for the start screen, with names the user gives them ("Маша, 2 класс").
const { app } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const file = () => path.join(app.getPath('userData'), 'recent.json');
const CODE = /^[\w-]{4,32}$/;

function load() {
  try { return JSON.parse(fs.readFileSync(file(), 'utf8')); } catch { return []; }
}
const save = (list) => fs.writeFileSync(file(), JSON.stringify(list.slice(0, 12)));

function visit(code) {
  if (!CODE.test(code)) return;
  const list = load();
  const name = list.find((r) => r.code === code)?.name ?? '';
  save([{ code, name, at: Date.now() }, ...list.filter((r) => r.code !== code)]);
}

function rename(code, name) {
  save(load().map((r) => (r.code === code ? { ...r, name: String(name).slice(0, 60) } : r)));
}

const remove = (code) => save(load().filter((r) => r.code !== code));

module.exports = { load, visit, rename, remove };
