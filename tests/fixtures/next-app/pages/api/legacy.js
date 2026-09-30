// Pages Router API route — answers every method.
export default function handler(req, res) {
  res.status(200).json({ legacy: true });
}
