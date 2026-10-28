import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';

function App() {
  const [a, setA] = useState('');
  const [b, setB] = useState('');
  const [c, setC] = useState('');
  return (
    <div>
      <input id="r-input" value={a} onChange={(e) => setA(e.target.value)} placeholder="React controlled input" />
      <textarea id="r-ta" value={b} onChange={(e) => setB(e.target.value)} placeholder="React controlled textarea" />
      <input id="r-upper" value={c} onChange={(e) => setC(e.target.value.toUpperCase())} placeholder="React uppercasing input" />
      <pre id="r-state">{JSON.stringify({ a, b, c })}</pre>
    </div>
  );
}
createRoot(document.getElementById('root')).render(<App />);
