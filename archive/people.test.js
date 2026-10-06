import { test } from 'node:test';
import assert from 'node:assert/strict';
import { firstNameOf, lastInitialOf, mergePersonRecord } from './people.js';

test('firstNameOf takes the first token only', () => {
  assert.equal(firstNameOf('Daphne Dow'), 'Daphne');
  assert.equal(firstNameOf('Taylor Testperson'), 'Taylor');
  assert.equal(firstNameOf('Cher'), 'Cher');
});

test('mergePersonRecord creates a new record with one appearance', () => {
  const rec = mergePersonRecord(null, {
    userId: 14668864, firstName: 'Daphne',
    programId: 5056676, teamId: 8022079, teamName: '7. Volley Llamas (Daphne D.)', isCaptain: true,
  });
  assert.equal(rec.userId, 14668864);
  assert.equal(rec.firstName, 'Daphne');
  assert.equal(rec.appearances.length, 1);
  assert.equal(rec.appearances[0].isCaptain, true);
  assert.equal(JSON.stringify(rec).includes('Dow'), false, 'full name/last name must never appear in the record');
});

test('mergePersonRecord appends a new season without duplicating an existing one', () => {
  const first = mergePersonRecord(null, {
    userId: 1, firstName: 'Sam', programId: 100, teamId: 200, teamName: 'Team A', isCaptain: false,
  });
  const second = mergePersonRecord(first, {
    userId: 1, firstName: 'Sam', programId: 101, teamId: 201, teamName: 'Team B', isCaptain: true,
  });
  assert.equal(second.appearances.length, 2);
  const third = mergePersonRecord(second, {
    userId: 1, firstName: 'Sam', programId: 100, teamId: 200, teamName: 'Team A', isCaptain: false,
  });
  assert.equal(third.appearances.length, 2, 're-seeing the same program+team must not duplicate');
});

test('lastInitialOf abbreviates the surname to one initial', () => {
  assert.equal(lastInitialOf('Daphne Dow'), 'D.');
  assert.equal(lastInitialOf('Taylor Testperson'), 'T.');
});

test('lastInitialOf returns empty for a single-token name', () => {
  // Same case firstNameOf is already tested against. A stray "." would
  // render in the picker as "Cher ." -- so this must be empty, not ".".
  assert.equal(lastInitialOf('Cher'), '');
  assert.equal(lastInitialOf('   '), '');
});

test('lastInitialOf uses the LAST token, not the second', () => {
  // "Mary Jo Smith" must give S., not J. -- middle names exist.
  assert.equal(lastInitialOf('Mary Jo Smith'), 'S.');
});

test('lastInitialOf handles apostrophes, hyphens and lowercase particles', () => {
  assert.equal(lastInitialOf("Sean O'Brien"), 'O.');
  assert.equal(lastInitialOf('Ada Smith-Jones'), 'S.');
  assert.equal(lastInitialOf('Ludwig van Beethoven'), 'B.');
});
