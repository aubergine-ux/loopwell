// What Pluck looks like. A host calls createElement(plugin) and puts whatever
// comes back on screen; it can be any HTML. This one makes a slider for each
// of the plugin's parameters, read from the plugin itself, so adding a
// parameter in processor.js is all it takes for it to show up here.

export async function createElement(plugin) {
  const node = plugin.audioNode;
  const info = await node.getParameterInfo();
  const values = await node.getParameterValues();

  const root = document.createElement('div');
  root.style.cssText = 'display:grid;gap:14px;padding:18px 20px;min-width:260px;font:14px system-ui,sans-serif;color:inherit';
  const title = document.createElement('div');
  title.textContent = 'Pluck';
  title.style.cssText = 'font-size:20px;font-weight:700;letter-spacing:-0.01em';
  root.append(title);

  for (const id of Object.keys(info)) {
    const p = info[id];
    const row = document.createElement('label');
    row.style.cssText = 'display:grid;grid-template-columns:110px 1fr 52px;align-items:center;gap:10px';
    const name = document.createElement('span');
    name.textContent = p.label || id;
    const slider = document.createElement('input');
    slider.type = 'range';
    slider.min = p.minValue;
    slider.max = p.maxValue;
    slider.step = (p.maxValue - p.minValue) / 200;
    slider.value = values[id] ? values[id].value : p.defaultValue;
    slider.setAttribute('aria-label', p.label || id);
    const read = document.createElement('output');
    read.style.cssText = 'font:12px ui-monospace,monospace;text-align:right;opacity:.7';
    const show = () => { read.textContent = `${(+slider.value).toFixed(2)}${p.units ? ` ${p.units}` : ''}`; };
    slider.addEventListener('input', () => {
      show();
      node.setParameterValues({ [id]: { id, value: +slider.value, normalized: false } });
    });
    show();
    row.append(name, slider, read);
    root.append(row);
  }
  return root;
}
