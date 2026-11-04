import Link from 'next/link';

/** Корень — служебная страница со ссылками на демо-токены. */
export default function Home() {
  const tokens = ['7Kx2', 'demo', 'kupe', 'niche', '2sec', 'doors', 'noprice', 'expired', 'revoked', 'unknown'];
  return (
    <main className="ek" style={{ padding: 24 }}>
      <h1 className="title">Ссылка клиента — демо</h1>
      <ul className="demo-list">
        {tokens.map((tk) => (
          <li key={tk}>
            <Link href={`/p/${tk}`}>/p/{tk}</Link>
          </li>
        ))}
      </ul>
    </main>
  );
}
