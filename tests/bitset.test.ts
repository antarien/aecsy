import {Bitset} from '../src/datatypes/bitset';

describe('bitset operations', () => {

  test('set in base cell', () => {
    const bitset = new Bitset(32);
    bitset.set(1);
    expect(bitset.get(1)).toBe(true);
    expect(bitset.get(2)).toBe(false);
  });

  test('unset in base cell', () => {
    const bitset = new Bitset(32);
    bitset.set(1);
    bitset.unset(1);
    expect(bitset.get(1)).toBe(false);
    expect(bitset.get(2)).toBe(false);
  });

  test('set in high cell', () => {
    const bitset = new Bitset(64);
    bitset.set(33);
    expect(bitset.get(33)).toBe(true);
    expect(bitset.get(1)).toBe(false);
    expect(bitset.get(36)).toBe(false);
  });

  test('clear', () => {
    const bitset = new Bitset(50);
    bitset.set(1);
    bitset.set(33);
    bitset.clear();
    expect(bitset.get(1)).toBe(false);
    expect(bitset.get(2)).toBe(false);
    expect(bitset.get(33)).toBe(false);
    expect(bitset.get(49)).toBe(false);
  });

  test('clear after set, unset and set again in the same word', () => {
    const bitset = new Bitset(64);
    bitset.set(3);
    bitset.unset(3);
    bitset.set(5);
    bitset.clear();
    expect(bitset.get(3)).toBe(false);
    expect(bitset.get(5)).toBe(false);
    bitset.set(7);
    expect(bitset.get(7)).toBe(true);
    expect(bitset.get(5)).toBe(false);
  });

  test('clear zeroes every touched word past the growth of the word list', () => {
    const size = 32 * 1024;
    const bitset = new Bitset(size);
    for (let i = 0; i < 100; i++) bitset.set(i * 32 + (i % 32));
    bitset.clear();
    for (let i = 0; i < size; i++) expect(bitset.get(i)).toBe(false);
  });

  test('clear past an eighth of the words falls to one fill and stays exact', () => {
    const size = 32 * 64;
    const bitset = new Bitset(size);
    for (let i = 0; i < size; i += 3) bitset.set(i);
    bitset.clear();
    for (let i = 0; i < size; i++) expect(bitset.get(i)).toBe(false);
    bitset.set(40);
    bitset.clear();
    expect(bitset.get(40)).toBe(false);
  });

  test('repeated clears across frames keep only the bits of the current frame', () => {
    const bitset = new Bitset(32 * 2048);
    for (let frame = 0; frame < 50; frame++) {
      const id = (frame * 997) % (32 * 2048);
      bitset.set(id);
      expect(bitset.get(id)).toBe(true);
      bitset.clear();
      expect(bitset.get(id)).toBe(false);
    }
  });

});

