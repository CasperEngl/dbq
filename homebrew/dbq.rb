class Dbq < Formula
  desc "Local MCP server and CLI for named databases"
  homepage "https://github.com/CasperEngl/dbq"
  version "0.1.0"

  on_macos do
    on_arm do
      url "https://github.com/CasperEngl/dbq/releases/download/v#{version}/dbq-v#{version}-darwin-arm64.tar.gz"
      sha256 "REPLACE_WITH_RELEASE_SHA256"
    end
  end

  def install
    bin.install "bin/dbq"
    bin.install "bin/dbq-confirm"
    pkgshare.install "config.example.toml"
  end

  def caveats
    <<~EOS
      Create your DBQ config:
        mkdir -p ~/.dbq
        cp #{pkgshare}/config.example.toml ~/.dbq/config.toml
        chmod 600 ~/.dbq/config.toml

      Start the MCP server with:
        dbq mcp
    EOS
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/dbq --version")
  end
end
