// CodeMirror 6 entry — imports the modules we use, re-exports on window.
// One-shot: bundled by build-cm6.sh into cm6-bundle.js (IIFE), committed.
import { EditorState, EditorSelection, Compartment, Transaction } from "@codemirror/state";
import {
  EditorView, keymap, lineNumbers, highlightActiveLine,
  highlightActiveLineGutter, drawSelection,
} from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import {
  syntaxHighlighting, defaultHighlightStyle, HighlightStyle,
  bracketMatching, indentOnInput, syntaxTree,
} from "@codemirror/language";
import { markdown } from "@codemirror/lang-markdown";
import { tags as t } from "@lezer/highlight";
import {
  search, searchKeymap, openSearchPanel, closeSearchPanel,
  getSearchQuery, setSearchQuery, SearchQuery,
  findNext, findPrevious, replaceNext, replaceAll,
} from "@codemirror/search";

window.MD4X_CM6 = {
  EditorState, EditorSelection, Compartment, Transaction,
  EditorView, keymap, lineNumbers, highlightActiveLine,
  highlightActiveLineGutter, drawSelection,
  defaultKeymap, history, historyKeymap, indentWithTab,
  syntaxHighlighting, defaultHighlightStyle, HighlightStyle,
  bracketMatching, indentOnInput, syntaxTree,
  markdown, t,
  search, searchKeymap, openSearchPanel, closeSearchPanel,
  getSearchQuery, setSearchQuery, SearchQuery,
  findNext, findPrevious, replaceNext, replaceAll,
};
