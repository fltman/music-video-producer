// remapMediaIds — den plats där en glömd referens tyst skulle få ett duplicerat
// projekt att peka på originalets mediafiler.

import { test, assert, assertEqual } from './harness.mjs';
import { remapMediaIds } from '../src/store/projects.js';
import { createProject, createFlow, createClip, createMediaRef } from '../src/core/model.js';

function projektMedMedia() {
  const a = createMediaRef({ id: 'm1', name: 'klipp a', kind: 'video', duration: 4 });
  const b = createMediaRef({ id: 'm2', name: 'klipp b', kind: 'video', duration: 4 });
  const låt = createMediaRef({ id: 'm3', name: 'låt', kind: 'audio', duration: 200 });
  const flöde = createFlow({ id: 'w1' }, 0);
  flöde.clips = [createClip('m1'), createClip('m2'), createClip('m1')];
  const tomt = createFlow({ id: 'w2' }, 1);
  const p = createProject({ media: [a, b, låt], flows: [flöde, tomt] });
  p.audio.mediaId = 'm3';
  return p;
}

const karta = new Map([['m1', 'x1'], ['m2', 'x2'], ['m3', 'x3']]);

test('medielistans id skrivs om', () => {
  const p = remapMediaIds(projektMedMedia(), karta);
  assertEqual(p.media.map((m) => m.id).join(','), 'x1,x2,x3');
});

test('klippens mediaId skrivs om, även upprepade', () => {
  const p = remapMediaIds(projektMedMedia(), karta);
  assertEqual(p.flows[0].clips.map((c) => c.mediaId).join(','), 'x1,x2,x1');
});

test('låtens mediaId skrivs om', () => {
  const p = remapMediaIds(projektMedMedia(), karta);
  assertEqual(p.audio.mediaId, 'x3');
});

test('inget gammalt id blir kvar någonstans i projektet', () => {
  const p = remapMediaIds(projektMedMedia(), karta);
  const json = JSON.stringify(p);
  for (const gammalt of karta.keys()) {
    assert(!json.includes(`"${gammalt}"`), `${gammalt} finns kvar i kopian`);
  }
});

test('id utan motsvarighet i kartan lämnas orörda', () => {
  const p = projektMedMedia();
  p.flows[0].clips.push(createClip('okänt'));
  remapMediaIds(p, new Map([['m1', 'x1']]));
  assertEqual(p.flows[0].clips[3].mediaId, 'okänt', 'okänt id ska stå kvar');
  assertEqual(p.flows[0].clips[1].mediaId, 'm2', 'omappat id ska stå kvar');
  assertEqual(p.audio.mediaId, 'm3', 'omappad låt ska stå kvar');
});

test('tom karta lämnar projektet oförändrat', () => {
  const före = JSON.stringify(projektMedMedia());
  const efter = JSON.stringify(remapMediaIds(projektMedMedia(), new Map()));
  assertEqual(efter, före);
});

test('tåligt mot saknade listor och null', () => {
  assertEqual(remapMediaIds(null, karta), null);
  const magert = { media: null, flows: null, audio: null };
  remapMediaIds(magert, karta);
  assert(true, 'ska inte kasta');
  const utanLjud = { media: [{ id: 'm1' }], flows: [{ clips: null }] };
  remapMediaIds(utanLjud, karta);
  assertEqual(utanLjud.media[0].id, 'x1');
});

test('ett flöde utan klipp stör inte omskrivningen', () => {
  const p = remapMediaIds(projektMedMedia(), karta);
  assertEqual(p.flows[1].clips.length, 0);
  assertEqual(p.flows[0].clips[0].mediaId, 'x1');
});
