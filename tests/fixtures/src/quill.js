import Quill from 'quill';
const quill = new Quill('#quill', {});
window.quill = quill;
window.quillText = () => quill.getText();
