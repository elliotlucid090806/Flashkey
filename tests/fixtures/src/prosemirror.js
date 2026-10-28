import { EditorState } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { schema } from 'prosemirror-schema-basic';
import { history, undo, redo } from 'prosemirror-history';
import { keymap } from 'prosemirror-keymap';
import { baseKeymap } from 'prosemirror-commands';

// ChatGPT-style composer: ProseMirror + Enter submits.
window.pmSubmits = 0;
const submit = () => { window.pmSubmits++; return true; };
const hardBreak = (state, dispatch) => {
  if (dispatch) dispatch(state.tr.replaceSelectionWith(schema.nodes.hard_break.create()).scrollIntoView());
  return true;
};
const view = new EditorView(document.getElementById('pm'), {
  state: EditorState.create({
    schema,
    plugins: [history(), keymap({ 'Mod-z': undo, 'Mod-y': redo, 'Shift-Mod-z': redo, Enter: submit, 'Shift-Enter': hardBreak }), keymap(baseKeymap)]
  })
});
window.pmView = view;
window.pmText = () => view.state.doc.textBetween(0, view.state.doc.content.size, '\n', '\n');
window.pmHTML = () => view.dom.innerHTML;
