//! Binary entry point for MPE Agent plugin.

use mpe_plugin_agent::AgentPlugin;

fn install_rustls() {
    let _ = rustls::crypto::ring::default_provider().install_default();
}

fn main() {
    install_rustls();
    std::process::exit(mpe_plugin_sdk::__plugin_main::<AgentPlugin>());
}
