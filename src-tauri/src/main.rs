// Prevents an extra console window from opening alongside the app on Windows release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    personal_finance_tool_lib::run()
}
