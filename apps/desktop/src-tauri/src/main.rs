// Release builds are GUI-only; debug keeps the console so capture warnings are visible.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    better_alt1_lib::run();
}
