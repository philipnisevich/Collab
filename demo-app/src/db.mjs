// In-memory "database". Deliberately simple — the demo is about the agents,
// not the app.
export const db = {
  users: new Map([
    ["1", { id: "1", name: "Ada Lovelace", email: "ada@example.com" }],
    ["2", { id: "2", name: "Grace Hopper", email: "grace@example.com" }],
    ["3", { id: "3", name: "Alan Turing", email: "alan@example.com" }],
  ]),
};
