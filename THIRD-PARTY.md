# Third-party components

Porchfest is MIT-licensed. The table below records every direct application, development,
container, and CI component declared by this repository. Transitive packages retain their own
license notices in their distributions.

| Component                                                 |                Declared range/tag | Purpose                              | License                          |
| --------------------------------------------------------- | --------------------------------: | ------------------------------------ | -------------------------------- |
| Hono (`hono`)                                             |                        `^4.12.29` | HTTP application framework           | MIT                              |
| Hono Node server (`@hono/node-server`)                    |                          `^2.0.8` | Node HTTP adapter                    | MIT                              |
| Leaflet                                                   | host-page peer (`1.9.4` verified) | Interactive map rendering            | BSD-2-Clause                     |
| OpenStreetMap tile data                                   |          `tile.openstreetmap.org` | Base map tiles                       | ODbL 1.0                         |
| better-sqlite3                                            |                        `^12.11.1` | Native SQLite driver                 | MIT                              |
| Drizzle ORM (`drizzle-orm`)                               |                         `^0.45.2` | Typed persistence toolkit            | Apache-2.0                       |
| dotenv                                                    |                         `^17.4.2` | Local environment-file loading       | BSD-2-Clause                     |
| tsx                                                       |                         `^4.23.0` | TypeScript runtime                   | MIT                              |
| TypeScript                                                |                          `^5.9.3` | Compiler and type checker            | Apache-2.0                       |
| Node type definitions (`@types/node`)                     |                        `^24.13.3` | Node TypeScript declarations         | MIT                              |
| better-sqlite3 type definitions (`@types/better-sqlite3`) |                         `^7.6.13` | Driver TypeScript declarations       | MIT                              |
| Drizzle Kit (`drizzle-kit`)                               |                        `^0.31.10` | Migration generation                 | Apache-2.0                       |
| Vitest                                                    |                         `^4.1.10` | Test runner                          | MIT                              |
| ESLint                                                    |                         `^9.39.0` | Linter                               | MIT                              |
| ESLint JavaScript config (`@eslint/js`)                   |                         `^9.39.0` | Recommended JavaScript rules         | MIT                              |
| typescript-eslint                                         |                         `^8.63.0` | TypeScript ESLint integration        | MIT                              |
| Prettier                                                  |                          `^3.9.5` | Formatting verification              | MIT                              |
| Node.js                                                   |                         `24-slim` | Builder and runtime base             | MIT                              |
| npm CLI                                                   |           bundled with Node image | Workspace package manager            | Artistic-2.0                     |
| Debian slim base and build packages                       |           Node image distribution | Container operating system/toolchain | Various DFSG-compatible licenses |
| SQLite                                                    |    bundled through better-sqlite3 | Embedded database engine             | Public domain                    |
| Caddy                                                     |                     `2.10-alpine` | TLS termination and reverse proxy    | Apache-2.0                       |
| Alpine Linux                                              |          Caddy image distribution | Proxy container operating system     | Various open-source licenses     |
| Docker Compose                                            |                 host prerequisite | Reference deployment orchestration   | Apache-2.0                       |
| `actions/checkout`                                        |                              `v4` | CI source checkout                   | MIT                              |
| `actions/setup-node`                                      |                              `v4` | CI Node provisioning                 | MIT                              |

The map module renders the required “© OpenStreetMap contributors” attribution on the map. Any
deployment pointing at a different tile source must carry that source's own attribution.

No React, Vite, DOM test library, client SPA framework, or hosted-provider SDK is included.
