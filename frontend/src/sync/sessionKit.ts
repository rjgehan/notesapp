// What a DocumentSession needs from CodeMirror beyond its state (DESIGN §6.3): the undo history,
// the note language (headings and links readable without an editor) and the minimal diff for remote
// text. These pull in CodeMirror's view, language and parsers, so they are a chunk of their own,
// which a session loads together with its file (sessionKitHandle.ts); an editor's chunk has them too.
import { history } from '@codemirror/commands';
import { markdownNoteLanguage } from '../editor/language';
import { applyRemoteTextToState, remoteChanges, remoteTransaction } from '../editor/remoteDiff';
import { provideSessionKit } from './sessionKitHandle';

export const sessionKit = { history, markdownNoteLanguage, applyRemoteTextToState, remoteChanges, remoteTransaction };

export type SessionKit = typeof sessionKit;

provideSessionKit(sessionKit);
