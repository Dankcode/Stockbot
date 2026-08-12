/** Keep persistence column names inside the server and expose shared-contract names. */
export function sessionResource(row) {
  if (!row) return row;
  const {
    paramsJson,
    symbolsJson,
    fillModelJson,
    riskProfileJson,
    scheduleJson,
    ...session
  } = row;
  return {
    ...session,
    params: row.params ?? paramsJson ?? {},
    symbols: row.symbols ?? symbolsJson ?? [],
    fillModel: row.fillModel ?? fillModelJson ?? {},
    riskProfile: row.riskProfile ?? riskProfileJson ?? {},
    schedule: row.schedule ?? scheduleJson ?? {}
  };
}

export function sessionDetailResource(value) {
  if (!value) return value;
  return { ...value, session: sessionResource(value.session) };
}

export function sessionCompareResource(value) {
  if (!value) return value;
  const keyAliases = {
    paramsJson: "params",
    symbolsJson: "symbols",
    fillModelJson: "fillModel",
    riskProfileJson: "riskProfile",
    scheduleJson: "schedule"
  };
  return {
    ...value,
    sessions: (value.sessions ?? []).map(sessionResource),
    details: (value.details ?? []).map(sessionDetailResource),
    configDiff: Object.fromEntries(
      Object.entries(value.configDiff ?? {}).map(([key, values]) => [keyAliases[key] ?? key, values])
    )
  };
}
