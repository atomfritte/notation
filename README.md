

&#x20; Test-Workflow (du brauchst Go 1.22 oder Docker):



&#x20; Option A — Docker:

&#x20; docker build -t notation .

&#x20; docker run --rm -p 8080:8080 -e NOTATION\_DEV\_BYPASS\_AUTH=1 -v $PWD/data:/data notation



&#x20; Option B — Go lokal:

&#x20; cd backend

&#x20; go mod tidy           # legt go.sum an

&#x20; NOTATION\_DEV\_BYPASS\_AUTH=1 NOTATION\_DATA\_DIR=./data go run ./cmd/notation



&#x20; Dann:

&#x20; 1. http://localhost:8080 → Admin UI (Dev-Bypass setzt Remote-User=dev-admin)

&#x20; 2. Space erstellen, File anlegen → schau ob in ./data/spaces/<id>/files/ + .git/ landet

&#x20; 3. Sidebar → "shares" → Magic Link erstellen → in privatem Browserfenster aufmachen

&#x20; 4. Sidebar → "mcp" → Token erstellen → JSON-Snippet kopieren → in Claude Code MCP-config einfügen → claude mcp list sollte den Server zeigen



&#x20; Erwartete Bruchstellen / wo Go-Compile wahrscheinlich noch zickt:

&#x20; - Eventuell go mod tidy lokal nötig (kein go.sum committed)

&#x20; - chi v5.0.12 ist released, sollte aber go mod download ziehen — wenn nicht, neuere Version probieren

&#x20; - Path-Test (path\_test.go) verlässt sich auf os.Symlink — auf Windows ohne Admin skip'd er sich selber



&#x20; Wenn docker build oder go run Compile-Errors wirft, schick mir den Output und ich fixe direkt. Stage 8 ziehe ich erst nach.



