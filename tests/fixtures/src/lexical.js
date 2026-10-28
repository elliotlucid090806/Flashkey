import { createEditor, $getRoot, KEY_ENTER_COMMAND, COMMAND_PRIORITY_HIGH } from 'lexical';
import { registerRichText, HeadingNode, QuoteNode } from '@lexical/rich-text';
import { registerHistory, createEmptyHistoryState } from '@lexical/history';

// WhatsApp-Web-style composer: Lexical + Enter sends, Shift+Enter = new line.
window.submits = 0;
const editor = createEditor({ namespace: 'fk', nodes: [HeadingNode, QuoteNode], onError: (e) => { throw e; } });
editor.setRootElement(document.getElementById('lexical'));
registerRichText(editor);
registerHistory(editor, createEmptyHistoryState(), 300);
editor.registerCommand(KEY_ENTER_COMMAND, (e) => {
  if (e && !e.shiftKey) { e.preventDefault(); window.submits++; return true; }
  return false;
}, COMMAND_PRIORITY_HIGH);
window.lexicalText = () => editor.getEditorState().read(() => $getRoot().getTextContent());
window.lexicalEditor = editor;
