import {COMMANDS, COMMAND_NAMES, isCommandEnabled} from '../background/chat-commands.js';

export function createCommandSettings(container, {onChange = () => {}} = {}) {
  const doc = container.ownerDocument;
  const controls = new Map();
  for (const name of COMMAND_NAMES) {
    const label = doc.createElement('label');
    label.className = 'command-toggle';
    const input = doc.createElement('input');
    input.type = 'checkbox';
    input.setAttribute('role', 'switch');
    input.setAttribute('aria-label', `/${name} を使用する`);
    const details = doc.createElement('span');
    const title = doc.createElement('code');
    title.textContent = `/${name}`;
    const description = doc.createElement('small');
    description.textContent = COMMANDS.filter(command => command.name === name).map(command => command.description).join(' ／ ');
    details.append(title, description);
    const status = doc.createElement('span');
    status.className = 'command-toggle-state';
    const update = () => {status.textContent = input.checked ? 'ON' : 'OFF';};
    input.checked = true;
    update();
    input.addEventListener('input', () => {update(); onChange();});
    label.append(input, details, status);
    container.append(label);
    controls.set(name, {input, update});
  }
  return {
    render(config) {
      for (const [name, {input, update}] of controls) {input.checked = isCommandEnabled(config, name); update();}
    },
    collect() {return Object.fromEntries([...controls].map(([name, {input}]) => [name, input.checked]));}
  };
}
