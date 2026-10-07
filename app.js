/**
 * VINTAGE MODULAR SYNTHESIZER - WEB AUDIO ENGINE & INTERFACE
 * Standard ES6+ Vanilla JavaScript
 */

document.addEventListener('DOMContentLoaded', () => {

    // ==========================================================================
    // 1. STATE & GLOBAL CONFIG
    // ==========================================================================
    const CONFIG = {
        jackTypes: {
            AUDIO_IN: 'AUDIO_IN',
            AUDIO_OUT: 'AUDIO_OUT',
            CV_IN: 'CV_IN',
            CV_OUT: 'CV_OUT',
            GATE_IN: 'GATE_IN',
            GATE_OUT: 'GATE_OUT'
        },
        cableColors: {
            AUDIO: '#e74c3c', // Rosso
            CV: '#f1c40f',    // Giallo
            GATE: '#2ecc71'   // Verde
        }
    };

    const state = {
        audioCtx: null,
        isStarted: false,
        octaveOffset: 0, // Ottava di base tastiera (0 = C4)
        modules: {},
        patches: [], // Lista connessioni attive
        dragCable: null, // Dati cavo in fase di trascinamento
        dragModule: null, // Dati modulo in fase di drag
        activeNotes: new Set()
    };

    // Mappatura Tasti Fisici Tastiera PC -> Note Semitoni da C
    const KEYMAP = {
        'a': 0,  'w': 1,  's': 2,  'e': 3,  'd': 4,  'f': 5,  't': 6,
        'g': 7,  'y': 8,  'h': 9,  'u': 10, 'j': 11, 'k': 12, 'o': 13,
        'l': 14, 'p': 15, 'ò': 16, 'à': 17
    };

    // ==========================================================================
    // 2. AUDIO ENGINE & NODES
    // ==========================================================================
    function initAudioContext() {
        if (!state.audioCtx) {
            const AudioContextClass = window.AudioContext || window.webkitAudioContext;
            state.audioCtx = new AudioContextClass();
        }
        if (state.audioCtx.state === 'suspended') {
            state.audioCtx.resume();
        }
    }

    // ==========================================================================
    // 3. MODULE CLASSES
    // ==========================================================================

    class BaseModule {
        constructor(id, title, x, y) {
            this.id = id;
            this.title = title;
            this.x = x;
            this.y = y;
            this.jacks = {};
            this.element = null;
        }

        renderBase(width = 160) {
            const panel = document.createElement('div');
            panel.className = 'module-panel';
            panel.id = `module-${this.id}`;
            panel.style.left = `${this.x}px`;
            panel.style.top = `${this.y}px`;
            panel.style.width = `${width}px`;

            const header = document.createElement('div');
            header.className = 'module-header';
            header.innerHTML = `<div class="module-title">${this.title}</div>`;
            panel.appendChild(header);

            this.element = panel;
            return panel;
        }

        registerJack(id, label, type, audioNode, param = null) {
            this.jacks[id] = {
                id,
                label,
                type,
                audioNode,
                param, // Se presente, è un AudioParam per CV
                moduleId: this.id,
                element: null
            };
        }

        createJackElement(jackId) {
            const jackData = this.jacks[jackId];
            const wrapper = document.createElement('div');
            wrapper.className = 'jack-wrapper';

            const el = document.createElement('div');
            el.className = `jack jack-${jackData.type.toLowerCase()}`;
            el.dataset.moduleId = this.id;
            el.dataset.jackId = jackId;
            el.innerHTML = '<div class="jack-hole"></div>';

            const label = document.createElement('span');
            label.className = 'jack-label';
            label.innerText = jackData.label;

            wrapper.appendChild(el);
            wrapper.appendChild(label);

            jackData.element = el;
            return wrapper;
        }

        createKnobElement(label, min, max, value, step, onChange) {
            const group = document.createElement('div');
            group.className = 'control-group';

            const ctrlLabel = document.createElement('span');
            ctrlLabel.className = 'control-label';
            ctrlLabel.innerText = label;

            const knobContainer = document.createElement('div');
            knobContainer.className = 'knob-container';

            const knobBody = document.createElement('div');
            knobBody.className = 'knob-body';

            const valDisplay = document.createElement('span');
            valDisplay.className = 'value-display';
            valDisplay.innerText = value;

            knobContainer.appendChild(knobBody);
            group.appendChild(ctrlLabel);
            group.appendChild(knobContainer);
            group.appendChild(valDisplay);

            // Logica di Interazione Manopola
            let currentValue = value;
            const updateKnobUI = (val) => {
                const norm = (val - min) / (max - min);
                const deg = -135 + norm * 270;
                knobBody.style.transform = `rotate(${deg}deg)`;
                valDisplay.innerText = Number.isInteger(step) ? val : val.toFixed(2);
            };

            updateKnobUI(currentValue);

            let startY = 0;
            let startVal = 0;

            const onPointerDown = (e) => {
                startY = e.clientY;
                startVal = currentValue;
                document.addEventListener('pointermove', onPointerMove);
                document.addEventListener('pointerup', onPointerUp);
            };

            const onPointerMove = (e) => {
                const deltaY = startY - e.clientY;
                const range = max - min;
                const sensitivity = e.shiftKey ? 0.001 : 0.005; // Shift per regolazione fine
                let newVal = startVal + deltaY * range * sensitivity;
                newVal = Math.max(min, Math.min(max, newVal));
                
                // Snap a step
                if (step >= 1) {
                    newVal = Math.round(newVal / step) * step;
                }

                currentValue = newVal;
                updateKnobUI(currentValue);
                onChange(currentValue);
            };

            const onPointerUp = () => {
                document.removeEventListener('pointermove', onPointerMove);
                document.removeEventListener('pointerup', onPointerUp);
            };

            knobContainer.addEventListener('pointerdown', onPointerDown);

            // Reset al doppio click
            knobContainer.addEventListener('dblclick', () => {
                currentValue = value;
                updateKnobUI(currentValue);
                onChange(currentValue);
            });

            return group;
        }
    }

    // --- 1. VCO MODULE ---
    class VCOModule extends BaseModule {
        constructor(id, x, y) {
            super(id, 'VCO', x, y);
            
            this.osc = state.audioCtx.createOscillator();
            this.baseOctave = 0;
            this.detuneValue = 0;
            this.osc.type = 'sawtooth';
            this.osc.frequency.setValueAtTime(261.63, state.audioCtx.currentTime); // C4
            this.osc.start();

            // Modulatore Frequenza (CV In converter)
            this.cvGain = state.audioCtx.createGain();
            this.cvGain.gain.value = 1200; // 1V/Octave -> 1200 cents/V
            this.cvGain.connect(this.osc.detune);

            this.outputGain = state.audioCtx.createGain();
            this.outputGain.gain.value = 0.8;
            this.osc.connect(this.outputGain);

            this.registerJack('cvPitch', 'PITCH CV', CONFIG.jackTypes.CV_IN, this.cvGain);
            this.registerJack('audioOut', 'AUDIO OUT', CONFIG.jackTypes.AUDIO_OUT, this.outputGain);

            this.render();
        }

        render() {
            const panel = this.renderBase();
            const content = document.createElement('div');
            content.className = 'module-content';

            // Waveform Selector
            const waveGroup = document.createElement('div');
            waveGroup.className = 'control-group';
            waveGroup.innerHTML = '<span class="control-label">WAVEFORM</span>';
            const select = document.createElement('select');
            select.className = 'module-select';
            select.innerHTML = `
                <option value="sawtooth">SAW</option>
                <option value="square">SQUARE</option>
                <option value="triangle">TRI</option>
                <option value="sine">SINE</option>
            `;
            select.addEventListener('change', (e) => { this.osc.type = e.target.value; });
            waveGroup.appendChild(select);
            content.appendChild(waveGroup);

            // Octave & Detune Knobs
            const knobOct = this.createKnobElement('OCTAVE', -2, 2, 0, 1, (val) => {
                this.baseOctave = val;
                this.updateFrequency();
            });
            const knobDetune = this.createKnobElement('DETUNE', -50, 50, 0, 0.1, (val) => {
                this.osc.detune.setValueAtTime(val, state.audioCtx.currentTime);
            });

            content.appendChild(knobOct);
            content.appendChild(knobDetune);

            // Jacks Row
            const jacksRow = document.createElement('div');
            jacksRow.className = 'jacks-row';
            jacksRow.appendChild(this.createJackElement('cvPitch'));
            jacksRow.appendChild(this.createJackElement('audioOut'));
            content.appendChild(jacksRow);

            panel.appendChild(content);
        }

        updateFrequency() {
            const freq = 261.63 * Math.pow(2, this.baseOctave);
            this.osc.frequency.setValueAtTime(freq, state.audioCtx.currentTime);
        }
    }

    // --- 2. VCF MODULE ---
    class VCFModule extends BaseModule {
        constructor(id, x, y) {
            super(id, 'VCF', x, y);

            this.filter = state.audioCtx.createBiquadFilter();
            this.filter.type = 'lowpass';
            this.filter.frequency.value = 1000;
            this.filter.Q.value = 1;

            // CV Cutoff Input Scaling
            this.cvGain = state.audioCtx.createGain();
            this.cvGain.gain.value = 2400; // Sensibilità modulazione filtro in Cents
            this.cvGain.connect(this.filter.detune);

            this.registerJack('audioIn', 'AUDIO IN', CONFIG.jackTypes.AUDIO_IN, this.filter);
            this.registerJack('cvCutoff', 'CUTOFF CV', CONFIG.jackTypes.CV_IN, this.cvGain);
            this.registerJack('audioOut', 'AUDIO OUT', CONFIG.jackTypes.AUDIO_OUT, this.filter);

            this.render();
        }

        render() {
            const panel = this.renderBase();
            const content = document.createElement('div');
            content.className = 'module-content';

            // Filter Type Selector
            const typeGroup = document.createElement('div');
            typeGroup.className = 'control-group';
            typeGroup.innerHTML = '<span class="control-label">TYPE</span>';
            const select = document.createElement('select');
            select.className = 'module-select';
            select.innerHTML = `
                <option value="lowpass">LOWPASS</option>
                <option value="highpass">HIGHPASS</option>
                <option value="bandpass">BANDPASS</option>
            `;
            select.addEventListener('change', (e) => { this.filter.type = e.target.value; });
            typeGroup.appendChild(select);
            content.appendChild(typeGroup);

            // Cutoff & Resonance Knobs
            const knobCutoff = this.createKnobElement('CUTOFF', 20, 12000, 1000, 1, (val) => {
                this.filter.frequency.setValueAtTime(val, state.audioCtx.currentTime);
            });
            const knobRes = this.createKnobElement('RESONANCE', 0, 20, 1, 0.1, (val) => {
                this.filter.Q.setValueAtTime(val, state.audioCtx.currentTime);
            });

            content.appendChild(knobCutoff);
            content.appendChild(knobRes);

            // Jacks
            const jacksRow1 = document.createElement('div');
            jacksRow1.className = 'jacks-row';
            jacksRow1.appendChild(this.createJackElement('audioIn'));
            jacksRow1.appendChild(this.createJackElement('cvCutoff'));

            const jacksRow2 = document.createElement('div');
            jacksRow2.className = 'jacks-row';
            jacksRow2.appendChild(this.createJackElement('audioOut'));

            content.appendChild(jacksRow1);
            content.appendChild(jacksRow2);

            panel.appendChild(content);
        }
    }

    // --- 3. VCA MODULE ---
    class VCAModule extends BaseModule {
        constructor(id, x, y) {
            super(id, 'VCA', x, y);

            this.gainNode = state.audioCtx.createGain();
            this.gainNode.gain.value = 0.0; // Inizialmente silente, controllato da CV/Envelope

            this.cvAmountGain = state.audioCtx.createGain();
            this.cvAmountGain.gain.value = 1.0;
            this.cvAmountGain.connect(this.gainNode.gain);

            this.registerJack('audioIn', 'AUDIO IN', CONFIG.jackTypes.AUDIO_IN, this.gainNode);
            this.registerJack('cvIn', 'CV IN', CONFIG.jackTypes.CV_IN, this.cvAmountGain);
            this.registerJack('audioOut', 'AUDIO OUT', CONFIG.jackTypes.AUDIO_OUT, this.gainNode);

            this.render();
        }

        render() {
            const panel = this.renderBase();
            const content = document.createElement('div');
            content.className = 'module-content';

            const knobInitial = this.createKnobElement('INITIAL GAIN', 0, 1, 0, 0.01, (val) => {
                this.gainNode.gain.setValueAtTime(val, state.audioCtx.currentTime);
            });
            const knobCvAmt = this.createKnobElement('CV AMOUNT', 0, 1, 1, 0.01, (val) => {
                this.cvAmountGain.gain.setValueAtTime(val, state.audioCtx.currentTime);
            });

            content.appendChild(knobInitial);
            content.appendChild(knobCvAmt);

            const jacksRow = document.createElement('div');
            jacksRow.className = 'jacks-row';
            jacksRow.appendChild(this.createJackElement('audioIn'));
            jacksRow.appendChild(this.createJackElement('cvIn'));

            const jacksRow2 = document.createElement('div');
            jacksRow2.className = 'jacks-row';
            jacksRow2.appendChild(this.createJackElement('audioOut'));

            content.appendChild(jacksRow);
            content.appendChild(jacksRow2);

            panel.appendChild(content);
        }
    }

    // --- 4. ADSR ENVELOPE MODULE ---
    class ADSRModule extends BaseModule {
        constructor(id, x, y) {
            super(id, 'ADSR', x, y);

            this.attack = 0.01;
            this.decay = 0.2;
            this.sustain = 0.5;
            this.release = 0.5;

            // Il modulo genera una costante DC (valore 1) la cui ampiezza è modulata dal profilo envelope
            this.constantSource = state.audioCtx.createConstantSource();
            this.constantSource.offset.value = 1.0;
            this.constantSource.start();

            this.envGain = state.audioCtx.createGain();
            this.envGain.gain.value = 0.0;
            this.constantSource.connect(this.envGain);

            // Virtual Receiver per Trigger Gate
            this.gateDummyNode = {
                triggerGate: (active) => this.handleGate(active)
            };

            this.registerJack('gateIn', 'GATE IN', CONFIG.jackTypes.GATE_IN, this.gateDummyNode);
            this.registerJack('envOut', 'ENV OUT', CONFIG.jackTypes.CV_OUT, this.envGain);

            this.render();
        }

        render() {
            const panel = this.renderBase();
            const content = document.createElement('div');
            content.className = 'module-content';

            const knobA = this.createKnobElement('ATTACK', 0.001, 3, 0.01, 0.01, (v) => this.attack = v);
            const knobD = this.createKnobElement('DECAY', 0.01, 3, 0.2, 0.01, (v) => this.decay = v);
            const knobS = this.createKnobElement('SUSTAIN', 0, 1, 0.5, 0.01, (v) => this.sustain = v);
            const knobR = this.createKnobElement('RELEASE', 0.01, 5, 0.5, 0.01, (v) => this.release = v);

            content.appendChild(knobA);
            content.appendChild(knobD);
            content.appendChild(knobS);
            content.appendChild(knobR);

            const jacksRow = document.createElement('div');
            jacksRow.className = 'jacks-row';
            jacksRow.appendChild(this.createJackElement('gateIn'));
            jacksRow.appendChild(this.createJackElement('envOut'));
            content.appendChild(jacksRow);

            panel.appendChild(content);
        }

        handleGate(active) {
            const now = state.audioCtx.currentTime;
            const param = this.envGain.gain;
            param.cancelScheduledValues(now);

            if (active) {
                // Attack Phase
                param.setValueAtTime(param.value, now);
                param.linearRampToValueAtTime(1.0, now + Math.max(0.005, this.attack));
                // Decay to Sustain Phase
                param.linearRampToValueAtTime(this.sustain, now + Math.max(0.005, this.attack) + Math.max(0.005, this.decay));
            } else {
                // Release Phase
                param.setValueAtTime(param.value, now);
                param.linearRampToValueAtTime(0.0, now + Math.max(0.005, this.release));
            }
        }
    }

    // --- 5. LFO MODULE ---
    class LFOModule extends BaseModule {
        constructor(id, x, y) {
            super(id, 'LFO', x, y);

            this.osc = state.audioCtx.createOscillator();
            this.osc.frequency.value = 2.0; // 2 Hz
            this.osc.type = 'sine';
            this.osc.start();

            this.amountGain = state.audioCtx.createGain();
            this.amountGain.gain.value = 1.0;
            this.osc.connect(this.amountGain);

            this.registerJack('out', 'LFO OUT', CONFIG.jackTypes.CV_OUT, this.amountGain);

            this.render();
        }

        render() {
            const panel = this.renderBase();
            const content = document.createElement('div');
            content.className = 'module-content';

            const waveGroup = document.createElement('div');
            waveGroup.className = 'control-group';
            waveGroup.innerHTML = '<span class="control-label">WAVE</span>';
            const select = document.createElement('select');
            select.className = 'module-select';
            select.innerHTML = `
                <option value="sine">SINE</option>
                <option value="triangle">TRI</option>
                <option value="square">SQ</option>
                <option value="sawtooth">SAW</option>
            `;
            select.addEventListener('change', (e) => { this.osc.type = e.target.value; });
            waveGroup.appendChild(select);
            content.appendChild(waveGroup);

            const knobRate = this.createKnobElement('RATE (HZ)', 0.1, 20, 2.0, 0.1, (val) => {
                this.osc.frequency.setValueAtTime(val, state.audioCtx.currentTime);
            });
            const knobAmt = this.createKnobElement('AMOUNT', 0, 5, 1.0, 0.1, (val) => {
                this.amountGain.gain.setValueAtTime(val, state.audioCtx.currentTime);
            });

            content.appendChild(knobRate);
            content.appendChild(knobAmt);

            const jacksRow = document.createElement('div');
            jacksRow.className = 'jacks-row';
            jacksRow.appendChild(this.createJackElement('out'));
            content.appendChild(jacksRow);

            panel.appendChild(content);
        }
    }

    // --- 6. MASTER OUTPUT MODULE ---
    class MasterOutputModule extends BaseModule {
        constructor(id, x, y) {
            super(id, 'OUTPUT', x, y);

            this.masterGain = state.audioCtx.createGain();
            this.masterGain.gain.value = 0.7; // Output di sicurezza

            this.limiter = state.audioCtx.createDynamicsCompressor();
            this.limiter.threshold.value = -1.0;
            this.limiter.knee.value = 0.0;
            this.limiter.ratio.value = 20.0;
            this.limiter.attack.value = 0.001;
            this.limiter.release.value = 0.1;

            this.masterGain.connect(this.limiter);
            this.limiter.connect(state.audioCtx.destination);

            this.registerJack('audioIn', 'AUDIO IN', CONFIG.jackTypes.AUDIO_IN, this.masterGain);

            this.render();
        }

        render() {
            const panel = this.renderBase();
            const content = document.createElement('div');
            content.className = 'module-content';

            const knobVol = this.createKnobElement('VOLUME', 0, 1, 0.7, 0.01, (val) => {
                this.masterGain.gain.setValueAtTime(val, state.audioCtx.currentTime);
            });

            // LED Indicatore Audio Attivo
            const ledGroup = document.createElement('div');
            ledGroup.className = 'control-group';
            ledGroup.innerHTML = '<span class="control-label">SIGNAL</span><div class="led-indicator active" id="master-led"></div>';

            content.appendChild(knobVol);
            content.appendChild(ledGroup);

            const jacksRow = document.createElement('div');
            jacksRow.className = 'jacks-row';
            jacksRow.appendChild(this.createJackElement('audioIn'));
            content.appendChild(jacksRow);

            panel.appendChild(content);
        }
    }

    // --- 7. KEYBOARD CONTROLLER MODULE ---
    class KeyboardControllerModule extends BaseModule {
        constructor(id, x, y) {
            super(id, 'KEYBOARD', x, y);

            // Generatore segnale CV Pitch Constant
            this.cvPitchSource = state.audioCtx.createConstantSource();
            this.cvPitchSource.offset.value = 0;
            this.cvPitchSource.start();

            // Virtual Gate Output Trigger
            this.gateTarget = null;

            this.registerJack('pitchOut', 'PITCH CV', CONFIG.jackTypes.CV_OUT, this.cvPitchSource);
            this.registerJack('gateOut', 'GATE OUT', CONFIG.jackTypes.GATE_OUT, {
                connectGate: (target) => { this.gateTarget = target; },
                disconnectGate: () => { this.gateTarget = null; }
            });

            this.render();
        }

        render() {
            const panel = this.renderBase();
            const content = document.createElement('div');
            content.className = 'module-content';

            const infoText = document.createElement('div');
            infoText.style.fontSize = '9px';
            infoText.style.textAlign = 'center';
            infoText.innerText = 'CONTROLLA PITCH E GATE TRAMITE LA TASTIERA IN BASSO.';
            content.appendChild(infoText);

            const jacksRow = document.createElement('div');
            jacksRow.className = 'jacks-row';
            jacksRow.appendChild(this.createJackElement('pitchOut'));
            jacksRow.appendChild(this.createJackElement('gateOut'));
            content.appendChild(jacksRow);

            panel.appendChild(content);
        }

        playNote(noteIndex) {
            // Converts note index (relative to C4) to 1V/Octave CV Signal
            // 12 semitoni = 1 Volts
            const volts = noteIndex / 12.0;
            this.cvPitchSource.offset.setValueAtTime(volts, state.audioCtx.currentTime);

            // Invia segnale Gate On
            if (this.gateTarget && typeof this.gateTarget.triggerGate === 'function') {
                this.gateTarget.triggerGate(true);
            }
        }

        stopNote() {
            // Invia segnale Gate Off
            if (this.gateTarget && typeof this.gateTarget.triggerGate === 'function') {
                this.gateTarget.triggerGate(false);
            }
        }
    }

    // ==========================================================================
    // 4. PATCH & CABLE SYSTEM
    // ==========================================================================

    function getJackCoordinates(jackElement) {
        const rackRect = document.getElementById('rack-viewport').getBoundingClientRect();
        const jackRect = jackElement.getBoundingClientRect();
        return {
            x: jackRect.left + jackRect.width / 2 - rackRect.left,
            y: jackRect.top + jackRect.height / 2 - rackRect.top
        };
    }

    function isJackCompatible(sourceType, targetType) {
        if (sourceType === CONFIG.jackTypes.AUDIO_OUT && targetType === CONFIG.jackTypes.AUDIO_IN) return true;
        if (sourceType === CONFIG.jackTypes.CV_OUT && targetType === CONFIG.jackTypes.CV_IN) return true;
        if (sourceType === CONFIG.jackTypes.GATE_OUT && targetType === CONFIG.jackTypes.GATE_IN) return true;
        return false;
    }

    function getSignalCategory(type) {
        if (type.startsWith('AUDIO')) return 'AUDIO';
        if (type.startsWith('CV')) return 'CV';
        return 'GATE';
    }

    function connectPatch(srcModuleId, srcJackId, destModuleId, destJackId) {
        const srcModule = state.modules[srcModuleId];
        const destModule = state.modules[destModuleId];
        const srcJack = srcModule.jacks[srcJackId];
        const destJack = destModule.jacks[destJackId];

        // Validazione compatibilità
        if (!isJackCompatible(srcJack.type, destJack.type)) {
            return false;
        }

        // Verifica se la connessione esiste già
        const exists = state.patches.some(p => 
            p.srcModuleId === srcModuleId && p.srcJackId === srcJackId &&
            p.destModuleId === destModuleId && p.destJackId === destJackId
        );
        if (exists) return false;

        // Connessione AudioNode o Logic Gate
        if (srcJack.type === CONFIG.jackTypes.GATE_OUT) {
            srcJack.audioNode.connectGate(destJack.audioNode);
        } else {
            srcJack.audioNode.connect(destJack.audioNode);
        }

        // Marca Jack Graficamente
        srcJack.element.classList.add('connected');
        destJack.element.classList.add('connected');

        // Aggiungi a registro patch
        const patch = {
            id: `patch-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
            srcModuleId,
            srcJackId,
            destModuleId,
            destJackId,
            category: getSignalCategory(srcJack.type)
        };
        state.patches.push(patch);

        renderCables();
        return true;
    }

    function disconnectPatch(patchId) {
        const idx = state.patches.findIndex(p => p.id === patchId);
        if (idx === -1) return;

        const patch = state.patches[idx];
        const srcModule = state.modules[patch.srcModuleId];
        const destModule = state.modules[patch.destModuleId];
        const srcJack = srcModule.jacks[patch.srcJackId];
        const destJack = destModule.jacks[patch.destJackId];

        // Scollegamento Web Audio
        try {
            if (srcJack.type === CONFIG.jackTypes.GATE_OUT) {
                srcJack.audioNode.disconnectGate();
            } else {
                srcJack.audioNode.disconnect(destJack.audioNode);
            }
        } catch (e) {
            console.warn('Disconnessione nodo audio:', e);
        }

        state.patches.splice(idx, 1);

        // Aggiorna stato visuale dei Jack se non hanno altri cavi
        [ { m: srcModule, j: srcJack, id: patch.srcJackId }, { m: destModule, j: destJack, id: patch.destJackId } ].forEach(item => {
            const hasOther = state.patches.some(p => 
                (p.srcModuleId === item.m.id && p.srcJackId === item.id) ||
                (p.destModuleId === item.m.id && p.destJackId === item.id)
            );
            if (!hasOther) {
                item.j.element.classList.remove('connected');
            }
        });

        renderCables();
    }

    // ==========================================================================
    // 5. CABLE RENDERER (SVG BEZIER)
    // ==========================================================================

    function drawBezierPath(p1, p2) {
        const dx = Math.abs(p2.x - p1.x);
        const dy = Math.abs(p2.y - p1.y);
        // Calcolo curva morbida gravitazionale verso il basso
        const slack = Math.max(dy * 0.5, Math.min(dx * 0.5, 150)) + 40;

        const cp1x = p1.x;
        const cp1y = p1.y + slack;
        const cp2x = p2.x;
        const cp2y = p2.y + slack;

        return `M ${p1.x} ${p1.y} C ${cp1x} ${cp1y}, ${cp2x} ${cp2y}, ${p2.x} ${p2.y}`;
    }

    function renderCables() {
        const svg = document.getElementById('cable-canvas');
        svg.innerHTML = ''; // Clear SVG

        // Renderizza Cavi Permanenti
        state.patches.forEach(patch => {
            const srcJackEl = state.modules[patch.srcModuleId].jacks[patch.srcJackId].element;
            const destJackEl = state.modules[patch.destModuleId].jacks[patch.destJackId].element;

            const p1 = getJackCoordinates(srcJackEl);
            const p2 = getJackCoordinates(destJackEl);

            const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
            path.setAttribute('d', drawBezierPath(p1, p2));
            path.setAttribute('stroke', CONFIG.cableColors[patch.category]);
            path.setAttribute('stroke-width', '5');
            path.setAttribute('fill', 'none');
            path.setAttribute('stroke-linecap', 'round');
            path.setAttribute('filter', 'drop-shadow(0px 4px 4px rgba(0,0,0,0.6))');
            path.dataset.patchId = patch.id;

            // Rimuovi Cavo al Doppio Click
            path.addEventListener('dblclick', () => {
                disconnectPatch(patch.id);
            });

            svg.appendChild(path);
        });

        // Renderizza Cavo in Trascinamento D&D
        if (state.dragCable) {
            const p1 = state.dragCable.startPos;
            const p2 = state.dragCable.currentPos;

            const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
            path.setAttribute('d', drawBezierPath(p1, p2));
            path.setAttribute('stroke', CONFIG.cableColors[state.dragCable.category]);
            path.setAttribute('stroke-width', '4');
            path.setAttribute('stroke-dasharray', '6,4');
            path.setAttribute('fill', 'none');
            path.setAttribute('stroke-linecap', 'round');

            svg.appendChild(path);
        }
    }

    // ==========================================================================
    // 6. INTERACTIVE DRAG & DROP (JACKS & MODULES)
    // ==========================================================================

    function setupInteractionListeners() {
        const rack = document.getElementById('rack-viewport');

        // --- INTERAZIONE JACKS (PULL CABLE) ---
        rack.addEventListener('pointerdown', (e) => {
            const jackEl = e.target.closest('.jack');
            if (!jackEl) return;

            e.stopPropagation();
            const moduleId = jackEl.dataset.moduleId;
            const jackId = jackEl.dataset.jackId;
            const jackData = state.modules[moduleId].jacks[jackId];

            const startPos = getJackCoordinates(jackEl);

            state.dragCable = {
                srcModuleId: moduleId,
                srcJackId: jackId,
                srcJackData: jackData,
                category: getSignalCategory(jackData.type),
                startPos,
                currentPos: { ...startPos }
            };

            document.addEventListener('pointermove', onCablePointerMove);
            document.addEventListener('pointerup', onCablePointerUp);
        });

        function onCablePointerMove(e) {
            if (!state.dragCable) return;
            const rackRect = rack.getBoundingClientRect();
            state.dragCable.currentPos = {
                x: e.clientX - rackRect.left,
                y: e.clientY - rackRect.top
            };
            requestAnimationFrame(renderCables);
        }

        function onCablePointerUp(e) {
            if (!state.dragCable) return;

            const targetJackEl = e.target.closest('.jack');
            if (targetJackEl) {
                const destModuleId = targetJackEl.dataset.moduleId;
                const destJackId = targetJackEl.dataset.jackId;

                connectPatch(
                    state.dragCable.srcModuleId,
                    state.dragCable.srcJackId,
                    destModuleId,
                    destJackId
                );
            }

            state.dragCable = null;
            document.removeEventListener('pointermove', onCablePointerMove);
            document.removeEventListener('pointerup', onCablePointerUp);
            renderCables();
        }

        // --- INTERAZIONE SPOSTAMENTO MODULI (DRAGGABLE) ---
        rack.addEventListener('pointerdown', (e) => {
            const panel = e.target.closest('.module-panel');
            if (!panel || e.target.closest('.jack') || e.target.closest('.knob-container') || e.target.closest('select')) return;

            const moduleId = panel.id.replace('module-', '');
            const module = state.modules[moduleId];

            const startX = e.clientX;
            const startY = e.clientY;
            const initialModuleX = module.x;
            const initialModuleY = module.y;

            const onModuleMove = (moveEv) => {
                const dx = moveEv.clientX - startX;
                const dy = moveEv.clientY - startY;

                const newX = Math.max(0, Math.min(1090, initialModuleX + dx));
                const newY = Math.max(0, Math.min(180, initialModuleY + dy));

                module.x = newX;
                module.y = newY;
                panel.style.left = `${newX}px`;
                panel.style.top = `${newY}px`;

                renderCables();
            };

            const onModuleUp = () => {
                document.removeEventListener('pointermove', onModuleMove);
                document.removeEventListener('pointerup', onModuleUp);
            };

            document.addEventListener('pointermove', onModuleMove);
            document.addEventListener('pointerup', onModuleUp);
        });
    }

    // ==========================================================================
    // 7. KEYBOARD CONTROLLER (VIRTUAL & PHYSICAL)
    // ==========================================================================

    function initKeyboard() {
        const kbContainer = document.getElementById('virtual-keyboard');
        kbContainer.innerHTML = '';

        const notes = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
        const totalKeys = 24; // 2 Ottave completi

        let whiteKeyCount = 0;

        for (let i = 0; i < totalKeys; i++) {
            const noteName = notes[i % 12];
            const isBlack = noteName.includes('#');

            const keyEl = document.createElement('div');
            keyEl.dataset.noteIndex = i;

            if (!isBlack) {
                keyEl.className = 'key-white';
                keyEl.innerText = `${noteName}`;
                whiteKeyCount++;
            } else {
                keyEl.className = 'key-black';
                // Posizionamento orizzontale relativo per i tasti neri
                keyEl.style.left = `${(whiteKeyCount - 0.7) * (100 / 14)}%`;
            }

            // Mouse / Touch Eventi Tastiera
            keyEl.addEventListener('pointerdown', (e) => {
                e.preventDefault();
                initAudioContext();
                triggerNoteOn(i);
            });

            keyEl.addEventListener('pointerup', () => triggerNoteOff(i));
            keyEl.addEventListener('pointerleave', () => triggerNoteOff(i));

            kbContainer.appendChild(keyEl);
        }

        // --- Tastiera Fisica PC ---
        window.addEventListener('keydown', (e) => {
            if (e.repeat || !state.isStarted) return;
            const key = e.key.toLowerCase();
            if (KEYMAP[key] !== undefined) {
                initAudioContext();
                triggerNoteOn(KEYMAP[key]);
            }
        });

        window.addEventListener('keyup', (e) => {
            if (!state.isStarted) return;
            const key = e.key.toLowerCase();
            if (KEYMAP[key] !== undefined) {
                triggerNoteOff(KEYMAP[key]);
            }
        });

        // Ottave
        document.getElementById('btn-octave-down').addEventListener('click', () => {
            state.octaveOffset = Math.max(-2, state.octaveOffset - 1);
            document.getElementById('octave-display').innerText = `OTTAVA: ${4 + state.octaveOffset}`;
        });
        document.getElementById('btn-octave-up').addEventListener('click', () => {
            state.octaveOffset = Math.min(2, state.octaveOffset + 1);
            document.getElementById('octave-display').innerText = `OTTAVA: ${4 + state.octaveOffset}`;
        });
    }

    function triggerNoteOn(noteIndex) {
        state.activeNotes.add(noteIndex);
        highlightKey(noteIndex, true);

        const calculatedIndex = noteIndex + (state.octaveOffset * 12);
        const kbdModule = state.modules['kbd1'];
        if (kbdModule) {
            kbdModule.playNote(calculatedIndex);
        }
    }

    function triggerNoteOff(noteIndex) {
        state.activeNotes.delete(noteIndex);
        highlightKey(noteIndex, false);

        if (state.activeNotes.size === 0) {
            const kbdModule = state.modules['kbd1'];
            if (kbdModule) {
                kbdModule.stopNote();
            }
        }
    }

    function highlightKey(noteIndex, active) {
        const keyEl = document.querySelector(`.virtual-keyboard [data-note-index="${noteIndex}"]`);
        if (keyEl) {
            if (active) keyEl.classList.add('active');
            else keyEl.classList.remove('active');
        }
    }

    // ==========================================================================
    // 8. PRESETS & INITIALIZATION
    // ==========================================================================

    function clearAllPatches() {
        // Disconnetti tutti i cavi
        [...state.patches].forEach(p => disconnectPatch(p.id));
    }

    function loadPreset(name) {
        clearAllPatches();

        if (name === 'basic') {
            // BASIC SYNTH (Keyboard -> VCO -> VCF -> VCA -> OUT & ADSR -> VCA CV)
            connectPatch('kbd1', 'pitchOut', 'vco1', 'cvPitch');
            connectPatch('kbd1', 'gateOut', 'adsr1', 'gateIn');
            connectPatch('vco1', 'audioOut', 'vcf1', 'audioIn');
            connectPatch('adsr1', 'envOut', 'vca1', 'cvIn');
            connectPatch('vcf1', 'audioOut', 'vca1', 'audioIn');
            connectPatch('vca1', 'audioOut', 'out1', 'audioIn');
        } 
        else if (name === 'lfo-filter') {
            // LFO FILTER MODULATION
            connectPatch('kbd1', 'pitchOut', 'vco1', 'cvPitch');
            connectPatch('kbd1', 'gateOut', 'adsr1', 'gateIn');
            connectPatch('vco1', 'audioOut', 'vcf1', 'audioIn');
            connectPatch('adsr1', 'envOut', 'vca1', 'cvIn');
            connectPatch('lfo1', 'out', 'vcf1', 'cvCutoff');
            connectPatch('vcf1', 'audioOut', 'vca1', 'audioIn');
            connectPatch('vca1', 'audioOut', 'out1', 'audioIn');
        } 
        else if (name === 'vibrato') {
            // LFO VIBRATO (LFO -> VCO PITCH)
            connectPatch('kbd1', 'pitchOut', 'vco1', 'cvPitch');
            connectPatch('kbd1', 'gateOut', 'adsr1', 'gateIn');
            connectPatch('lfo1', 'out', 'vco1', 'cvPitch');
            connectPatch('vco1', 'audioOut', 'vcf1', 'audioIn');
            connectPatch('adsr1', 'envOut', 'vca1', 'cvIn');
            connectPatch('vcf1', 'audioOut', 'vca1', 'audioIn');
            connectPatch('vca1', 'audioOut', 'out1', 'audioIn');
        }
        // INIT = nessun cavo collegato
    }

    function buildSynthRack() {
        const container = document.getElementById('modules-rack');
        container.innerHTML = '';

        // Posizionamento Layout Moduli nello Chassis (passo 170px per moduli larghezza 160px)
        state.modules['vco1'] = new VCOModule('vco1', 15, 15);
        state.modules['vcf1'] = new VCFModule('vcf1', 185, 15);
        state.modules['vca1'] = new VCAModule('vca1', 355, 15);
        state.modules['adsr1'] = new ADSRModule('adsr1', 525, 15);
        state.modules['lfo1'] = new LFOModule('lfo1', 695, 15);
        state.modules['out1'] = new MasterOutputModule('out1', 865, 15);
        state.modules['kbd1'] = new KeyboardControllerModule('kbd1', 1035, 15);

        Object.values(state.modules).forEach(m => {
            container.appendChild(m.element);
        });

        setupInteractionListeners();
    }

    // ==========================================================================
    // 9. STARTUP & CONTROLS BINDING
    // ==========================================================================

    const btnStart = document.getElementById('btn-start');
    const btnReset = document.getElementById('btn-reset');
    const presetSelect = document.getElementById('preset-select');

    btnStart.addEventListener('click', () => {
        initAudioContext();
        state.isStarted = true;

        // Inizializza Moduli Audio
        buildSynthRack();
        initKeyboard();

        // Carica Preset di Default (BASIC SYNTH)
        loadPreset('basic');

        // UI Updates
        btnStart.disabled = true;
        btnStart.innerText = 'SYNTH ACTIVE';
        btnStart.classList.remove('pulse');
        btnReset.disabled = false;
        presetSelect.disabled = false;
    });

    btnReset.addEventListener('click', () => {
        if (!state.isStarted) return;
        clearAllPatches();
        loadPreset('basic');
        presetSelect.value = 'basic';
    });

    presetSelect.addEventListener('change', (e) => {
        if (!state.isStarted) return;
        loadPreset(e.target.value);
    });

    // Redraw cavi su Window Resize
    window.addEventListener('resize', () => {
        if (state.isStarted) renderCables();
    });
});
