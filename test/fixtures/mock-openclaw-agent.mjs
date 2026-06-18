const writeResponse = () => {
  process.stdout.write(
    JSON.stringify({
      runId: "fixture-run",
      status: "ok",
      result: { payloads: [{ text: "fixture reply" }] },
    }),
  );
};

if (process.argv.includes("--sleep")) {
  setTimeout(writeResponse, 10_000);
} else {
  writeResponse();
}
