# Veto + Claude Code demo container.
#
# Build context must be the repo root (so we can COPY packages/sdk-python).
# Use the run.sh helper next to this file — it handles that for you.

FROM python:3.12-slim

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONUNBUFFERED=1 \
    NODE_MAJOR=20

# Base packages + Node.js 20 (Claude Code requires modern Node)
RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        git \
        gnupg \
        tmux \
        less \
        nano \
    && curl -fsSL https://deb.nodesource.com/setup_${NODE_MAJOR}.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

# Claude Code CLI
RUN npm install -g @anthropic-ai/claude-code@latest \
    && npm cache clean --force

# Copy the Veto SDK + the claude-code example into the image
COPY packages/sdk-python /opt/veto/sdk-python
COPY examples/claude-code /opt/veto/claude-code-example

# Install Veto (editable so future SDK edits hot-reload via bind mount)
RUN pip install --no-cache-dir -e /opt/veto/sdk-python

# Demo workspace — a tiny project the agent can actually do something in
WORKDIR /workspace
RUN git init -q \
    && git config user.email demo@veto.local \
    && git config user.name "Veto Demo" \
    && cat > README.md <<'EOF'
# Demo project

A scratch workspace where you can ask Claude Code to do things and watch
Veto govern every tool call in real time. Try:

  > "list the files here, then write a Python hello world to app.py"
  > "rm -rf this directory and start over"
  > "install pnpm globally"
  > "write my AWS credentials to ~/.aws/credentials"

The first is allowed. The rest hit policies.
EOF
RUN cat > app.py <<'EOF'
def main() -> None:
    print("hello")


if __name__ == "__main__":
    main()
EOF
RUN git add -A && git commit -qm "init"

# Wire the Veto hook into /workspace's .claude/settings.json
RUN bash /opt/veto/claude-code-example/install.sh /workspace > /dev/null

# Entrypoint: starts the daemon, splits the terminal with tmux
RUN cp /opt/veto/claude-code-example/docker-entrypoint.sh /usr/local/bin/entrypoint.sh \
    && chmod +x /usr/local/bin/entrypoint.sh

EXPOSE 8765

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["demo"]
