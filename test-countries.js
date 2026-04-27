async function test() {
  const res = await fetch('https://countriesnow.space/api/v0.1/countries/state/cities', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ country: 'Canada', state: 'Alberta' })
  });
  const data = await res.json();
  console.log(JSON.stringify(data.data.slice(0, 5), null, 2));
}
test();
