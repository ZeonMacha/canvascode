// Hide the extra black console window. This app is launched as a desktop tool.
#![cfg_attr(target_os = "windows", windows_subsystem = "windows")]

fn main() {
  app_lib::run();
}
