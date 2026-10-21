import { describe, expect, it } from 'vitest';
import { droppedLinks, editRaw, firstLink, shownFor } from './textLinks';

const raw = 'Owner: [[Project Plan|plan]] and [[Alice]]';
const shown = 'Owner: plan and Alice';

describe('editRaw: an edit of the shown text, carried over to the Markdown source', () => {
  it('keeps text typed next to a link outside it', () => {
    expect(editRaw(raw, shown, 'Owner: plan and Alice (lead)')).toBe('Owner: [[Project Plan|plan]] and [[Alice]] (lead)');
    expect(editRaw(raw, shown, 'Owner: plans and Alice')).toBe('Owner: [[Project Plan|plan]]s and [[Alice]]');
    expect(editRaw(raw, shown, 'New owner: plan and Alice')).toBe('New owner: [[Project Plan|plan]] and [[Alice]]');
    expect(editRaw(raw, shown, 'Owner: plan, Alice')).toBe('Owner: [[Project Plan|plan]], [[Alice]]');
  });

  it('keeps the target of a link whose shown text was edited, with the new text as its alias', () => {
    expect(editRaw(raw, shown, 'Owner: plot and Alice')).toBe('Owner: [[Project Plan|plot]] and [[Alice]]');
    expect(editRaw(raw, shown, 'Owner: plan and Alicia')).toBe('Owner: [[Project Plan|plan]] and [[Alice|Alicia]]');
    expect(editRaw('See [[Notes/Plan#Goals]]', 'See Notes/Plan#Goals', 'See the goals')).toBe('See [[Notes/Plan#Goals|the goals]]');
    expect(editRaw('Meet [[Plans|my plan]]', 'Meet my plan', 'Meet my big plan')).toBe('Meet [[Plans|my big plan]]');
    // Back to the target's own name: no alias.
    expect(editRaw('[[Alice|Alyce]]', 'Alyce', 'Alice')).toBe('[[Alice]]');
    // A link's whole text replaced keeps its target (the element shows its link).
    expect(editRaw(raw, shown, 'Owner: plan and Bob')).toBe('Owner: [[Project Plan|plan]] and [[Alice|Bob]]');
    expect(editRaw('Read [this](https://example.com/a)', 'Read this', 'Read that')).toBe('Read [that](https://example.com/a)');
  });

  it('drops a link whose whole text was deleted, and keeps the others', () => {
    expect(editRaw(raw, shown, 'Owner: Alice')).toBe('Owner: [[Alice]]');
    expect(editRaw(raw, shown, 'Owner: plan')).toBe('Owner: [[Project Plan|plan]]');
    expect(editRaw(raw, shown, 'Somebody else')).toBe('Somebody else');
  });

  it('keeps what is left of a link a word edit cuts into; a replaced phrase takes its links with it', () => {
    expect(editRaw(raw, shown, 'Owner: pl & Alice')).toBe('Owner: [[Project Plan|pl]] & [[Alice]]');
    expect(editRaw('[[Project Plan|plan]]s', 'plans', 'plots')).toBe('[[Project Plan|plot]]s');
    expect(editRaw(raw, shown, 'Owner: plXce')).toBe('Owner: plXce');
    // Letters two words happen to share (the last "e") do not keep a scrap of a link.
    expect(editRaw(raw, shown, 'Somebody else')).toBe('Somebody else');
  });

  it('reads the plugin’s other display settings: link brackets and a link prefix', () => {
    expect(editRaw(raw, 'Owner: [[plan]] and [[Alice]]', 'Owner: [[plan]] and [[Alice]]!')).toBe('Owner: [[Project Plan|plan]] and [[Alice]]!');
    expect(editRaw(raw, 'Owner: [[plan]] and [[Alice]]', 'Owner: [[plot]] and [[Alice]]')).toBe('Owner: [[Project Plan|plot]] and [[Alice]]');
    expect(editRaw(raw, '📍Owner: plan and Alice', '📍Owner: plan and Alice (lead)')).toBe('Owner: [[Project Plan|plan]] and [[Alice]] (lead)');
  });

  it('edits around a transclusion, never inside it', () => {
    const quote = 'Quote: ![[Notes#^abc]] (from Notes)';
    const quoted = 'Quote: the quoted words (from Notes)';
    expect(editRaw(quote, quoted, 'A quote: the quoted words (from Notes)')).toBe('A quote: ![[Notes#^abc]] (from Notes)');
    expect(editRaw(quote, quoted, 'Quote: the quoted words')).toBe('Quote: ![[Notes#^abc]]');
    expect(editRaw(quote, quoted, 'Quote: the changed words (from Notes)')).toBeNull();
  });

  it('gives up when the shown text does not follow from the source, or an alias cannot hold the text', () => {
    expect(editRaw(raw, 'Something else entirely', 'Something else')).toBeNull();
    expect(editRaw(raw, shown, 'Owner: pl]an and Alice')).toBeNull();
    expect(droppedLinks(raw, 'Owner: plan and Alice!')).toEqual(['[[Project Plan|plan]]', '[[Alice]]']);
  });

  it('takes the text itself when the source is what is shown (raw mode, or a text without links)', () => {
    expect(editRaw('Hello', 'Hello', 'Hello there')).toBe('Hello there');
    expect(editRaw(raw, raw, 'Owner: [[Alice]]')).toBe('Owner: [[Alice]]');
    expect(editRaw('Hello', 'Hello', 'Hello')).toBe('Hello');
  });
});

describe('shownFor: what a source a rename rewrote shows', () => {
  it('follows the rules the old source was shown with', () => {
    expect(shownFor('See [[Plumber Bob]]', 'See [[Plumber]]', 'See Plumber', 'parsed')).toBe('See Plumber Bob');
    expect(shownFor('See [[Plumber Bob|him]]', 'See [[Plumber|him]]', 'See him', 'parsed')).toBe('See him');
    expect(shownFor('See [[Plumber Bob]]', 'See [[Plumber]]', '📍See [[Plumber]]', 'parsed')).toBe('📍See [[Plumber Bob]]');
    expect(shownFor('See [[Plumber Bob]]', 'See [[Plumber]]', 'See [[Plumber]]', 'raw')).toBe('See [[Plumber Bob]]');
    expect(shownFor('Meet [[Alice]]', 'Meet Alice', 'Meet Alice', 'parsed')).toBe('Meet Alice');
  });

  it('cannot tell what a transclusion shows', () => {
    expect(shownFor('![[New#^abc]]', '![[Old#^abc]]', 'words', 'parsed')).toBeNull();
    expect(shownFor('See [[Plumber Bob]]', 'See [[Plumber]]', 'Unrelated', 'parsed')).toBeNull();
  });

  it('gives a text the link the plugin derives from it', () => {
    expect(firstLink('See [[Plumber Bob#Phone|him]] and [[Other]]')).toBe('[[Plumber Bob#Phone]]');
    expect(firstLink('Read [this](https://example.com)')).toBe('https://example.com');
    expect(firstLink('No links')).toBeNull();
  });
});
