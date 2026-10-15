// Lair Control | Daggerheart spotlight -> Home Assistant seat lighting
//
// Drop this file in scripts/ next to main.js, then add to main.js:
//   import { registerSpotlightSettings, initSpotlight } from './spotlight.js';
//   ...inside Hooks.once('init'), after `haClient = new HomeAssistantClient();`
//   registerSpotlightSettings();
//   initSpotlight(haClient);

import { HomeAssistantClient } from './api.js';

const MOD = 'foundry-ha-integration';
const SNAPSHOT_ID = 'lair_control_pre_spotlight';

let ha = null;
let lastEntity = null;     // seat entity currently lit by us (null = none)
let snapshotTaken = false;
let timer = null;
let queue = Promise.resolve();

export function registerSpotlightSettings() {
    game.settings.register(MOD, 'spotlightEnabled', {
        name: 'Spotlight lighting',
        hint: 'Light the seat of whoever has the Daggerheart spotlight.',
        scope: 'world', config: true, type: Boolean, default: true
    });

    // Stored as JSON {actorId: entityId}; edited through the menu below.
    game.settings.register(MOD, 'spotlightSeatMap', {
        scope: 'world', config: false, type: String, default: '{}'
    });

    game.settings.registerMenu(MOD, 'spotlightSeatsMenu', {
        name: 'Spotlight Seats',
        label: 'Configure Spotlight Seats',
        hint: 'Pick the Home Assistant light (e.g. a WLED segment) in front of each player character. Segment lights get the spotlight color/brightness; scripts and scenes are just turned on.',
        icon: 'fas fa-lightbulb',
        type: SpotlightSeatsForm,
        restricted: true
    });

    game.settings.register(MOD, 'spotlightColor', {
        name: 'Spotlight color',
        hint: 'Hex color for the lit seat, e.g. #ffd27a.',
        scope: 'world', config: true, type: String, default: '#ffd27a'
    });

    game.settings.register(MOD, 'spotlightBrightness', {
        name: 'Spotlight brightness (1-255)',
        scope: 'world', config: true, type: Number, default: 255,
        range: { min: 1, max: 255, step: 1 }
    });

    game.settings.register(MOD, 'spotlightRestoreMode', {
        name: 'When spotlight leaves a seat',
        hint: 'Restore: put the seat lights back how they were before the first spotlight (uses a Home Assistant scene snapshot). Off: turn the seat light off.',
        scope: 'world', config: true, type: String, default: 'snapshot',
        choices: { snapshot: 'Restore previous lighting', off: 'Turn seat light off' }
    });

    game.settings.register(MOD, 'spotlightDebug', {
        name: 'Spotlight debug logging',
        hint: 'Log what Lair Control sees on each combat update (F12 console).',
        scope: 'world', config: true, type: Boolean, default: false
    });
}

export function initSpotlight(client) {
    ha = client;

    Hooks.on('updateCombat', () => schedule());
    Hooks.on('updateCombatant', () => schedule());
    Hooks.on('deleteCombat', () => schedule(true));

    // Console helper: lairControlDumpSpotlight() while a Daggerheart encounter is running
    globalThis.lairControlDumpSpotlight = () => {
        const c = game.combat;
        console.log('Lair Control | combat', { turn: c?.turn, round: c?.round, started: c?.started });
        c?.combatants.forEach(x => console.log('Lair Control |', x.name, foundry.utils.deepClone(x.system)));
    };
}

function schedule(clear = false) {
    if (!game.user.isGM) return;
    // updateCombat and updateCombatant often fire together; coalesce them.
    clearTimeout(timer);
    timer = setTimeout(() => {
        queue = queue.then(() => evaluate(clear)).catch(e => console.error('Lair Control | spotlight error', e));
    }, 150);
}

function debug(...args) {
    if (game.settings.get(MOD, 'spotlightDebug')) console.log('Lair Control | spotlight', ...args);
}

// Foundryborne moves the spotlight by changing combat.turn (confirmed from
// updateCombat logs: only turn/round change, no combatant updates).
function getSpotlightCombatant(combat) {
    if (!combat?.started || !Number.isInteger(combat.turn)) return null;
    return combat.combatant ?? null;
}

function parseSeatMap() {
    try {
        const raw = JSON.parse(game.settings.get(MOD, 'spotlightSeatMap') || '{}');
        return Object.fromEntries(Object.entries(raw).map(([k, v]) => [k.trim().toLowerCase(), v]));
    } catch (e) {
        console.warn('Lair Control | spotlightSeatMap is not valid JSON', e);
        return {};
    }
}

function resolveSeat(combatant, map) {
    if (!combatant) return null;
    const names = [combatant.actor?.id, combatant.actorId, combatant.actor?.name, combatant.name];
    const owner = game.users.find(u => u.character?.id === combatant.actor?.id);
    if (owner) names.push(owner.name);
    for (const [userId, level] of Object.entries(combatant.actor?.ownership ?? {})) {
        if (level >= CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER && userId !== 'default') {
            const u = game.users.get(userId);
            if (u && !u.isGM) names.push(u.name);
        }
    }
    for (const n of names) {
        const hit = n && map[n.trim().toLowerCase()];
        if (hit) return hit;
    }
    return null;
}

function hexToRgb(hex) {
    const m = /^#?([0-9a-f]{6})$/i.exec((hex || '').trim());
    const n = parseInt(m ? m[1] : 'ffd27a', 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

const domainOf = id => id.split('.')[0];

async function lightOn(entity) {
    if (domainOf(entity) === 'light') {
        await ha.callService('light', 'turn_on', {
            entity_id: entity,
            rgb_color: hexToRgb(game.settings.get(MOD, 'spotlightColor')),
            brightness: game.settings.get(MOD, 'spotlightBrightness'),
            transition: 0.3
        });
    } else {
        await ha.callService(domainOf(entity), 'turn_on', { entity_id: entity });
    }
}

async function evaluate(clear) {
    if (!game.settings.get(MOD, 'spotlightEnabled')) return;

    const map = parseSeatMap();
    const combat = clear ? null : game.combat;
    const target = getSpotlightCombatant(combat);
    const entity = resolveSeat(target, map);

    debug('target', target?.name ?? null, '->', entity);
    if (entity === lastEntity) return;

    const restoreMode = game.settings.get(MOD, 'spotlightRestoreMode');
    const seatLights = [...new Set(Object.values(map))].filter(e => domainOf(e) === 'light');
    const prev = lastEntity;
    lastEntity = entity;

    // First spotlight of the encounter: remember how the table looked.
    if (entity && !snapshotTaken && restoreMode === 'snapshot' && seatLights.length) {
        await ha.callService('scene', 'create', {
            scene_id: SNAPSHOT_ID,
            snapshot_entities: seatLights
        });
        snapshotTaken = true;
    }

    // Spotlight left a seat (moved or cleared).
    if (prev) {
        if (restoreMode === 'snapshot' && snapshotTaken) {
            await ha.callService('scene', 'turn_on', {
                entity_id: `scene.${SNAPSHOT_ID}`,
                transition: 0.3
            });
        } else if (restoreMode === 'off' && domainOf(prev) === 'light') {
            await ha.callService('light', 'turn_off', { entity_id: prev, transition: 0.3 });
        }
    }

    if (entity) {
        await lightOn(entity);
    } else {
        snapshotTaken = false;
    }
}

// ---------------------------------------------------------------------------
// Settings form: one HA entity picker per player character
// ---------------------------------------------------------------------------
function rawSeatMap() {
    try { return JSON.parse(game.settings.get(MOD, 'spotlightSeatMap') || '{}'); }
    catch { return {}; }
}

const seatActors = () => game.actors.filter(a => a.type === 'character' && a.hasPlayerOwner);

class SpotlightSeatsForm extends FormApplication {
    static get defaultOptions() {
        return foundry.utils.mergeObject(super.defaultOptions, {
            id: 'lair-control-spotlight-seats',
            title: 'Lair Control: Spotlight Seats',
            template: `modules/${MOD}/templates/spotlight-seats.html`,
            width: 520,
            height: 'auto',
            closeOnSubmit: true
        });
    }

    async getData(options = {}) {
        const data = await super.getData(options);
        const entities = await new HomeAssistantClient().fetchEntities();
        data.entityOptions = entities.map(e => `<option value="${e}"></option>`).join('');
        const map = rawSeatMap();
        data.seats = seatActors().map(a => ({
            id: a.id,
            name: a.name,
            entity: map[a.id] ?? map[a.name] ?? ''
        }));
        return data;
    }

    async _updateObject(event, formData) {
        const map = {};
        for (const a of seatActors()) {
            const v = (formData[`seat-${a.id}`] ?? '').trim();
            if (v) map[a.id] = v;
        }
        await game.settings.set(MOD, 'spotlightSeatMap', JSON.stringify(map));
    }
}
