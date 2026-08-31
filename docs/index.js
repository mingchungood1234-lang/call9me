const nameInput = document.getElementById("nameInput");
const continueBtn = document.getElementById("continue");

function submitName() {
    const rawName = nameInput ? nameInput.value.trim() : "";
    const username = rawName.length > 0 ? rawName : "Anonymous";
    sessionStorage.setItem("username", username);
    window.location.href = "main.html";
}

if (continueBtn) {
    continueBtn.addEventListener("click", submitName);
}

if (nameInput) {
    nameInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
            submitName();
        }
    });
}
