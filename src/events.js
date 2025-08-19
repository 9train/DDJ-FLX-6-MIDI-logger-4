// /src/events.js
import { armSoftTakeoverForDeck } from './state-hooks.js';

function onTrackLoaded(deckId) {
  if (window.__MIDI_FEEL__) {
    const { FEEL, FEEL_CFG } = window.__MIDI_FEEL__;
    armSoftTakeoverForDeck(FEEL, FEEL_CFG, deckId);
  }
}
