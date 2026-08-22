document.getElementById("continue").addEventListener("click", () => {
    const username = document.getElementById("nameInput").value;
    sessionStorage.setItem("username", username);
    window.location.href = "main.html";
});
